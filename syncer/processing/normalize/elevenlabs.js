/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: ElevenLabs Normalizer (normalize/elevenlabs.js)
 * Description: Maps an ElevenLabs /v1/models entry to a canonical CortexModel.
 * Character limits land in limits.maxInputCharacters — never in
 * limits.contextTokens (they are not a token window).
 */

import { createCortexModel, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';
import { categoryFromElevenLabsModel } from './tasks.js';

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} model - Raw ElevenLabs model entry.
 * @param {{identity: {producer: string, series: string, variant: string}, canonicalKey: string,
 *          catalogMatch: object|null}} ctx
 */
export function normalizeElevenLabsModel(model, { identity, canonicalKey, catalogMatch }) {
    const modelId = model.model_id;
    const category = categoryFromElevenLabsModel(model, modelId);
    const realtime = category === 'stt' && /realtime/i.test(modelId);
    const generation = /(?:^|[_ -])v(\d+)(?:$|[_ -])/i.exec(String(modelId || ''))?.[1] || null;
    const record = createCortexModel({
        id: modelId,
        source: 'elevenlabs',
        canonicalKey,
        category,
        task: realtime ? 'realtime_stt' : null,
    });

    record.identity = identityFrom({
        id: modelId,
        displayName: model.name,
        producer: identity.producer,
        series: identity.series,
        variant: identity.variant,
        version: model.version || (generation ? `v${generation}` : null),
    });

    record.modalities = {
        input: category === 'tts' ? ['text'] : ['audio'],
        output: category === 'stt' ? ['text'] : ['audio'],
        architectureModality: null,
    };

    // Character limits are their own field; contextTokens stays absent (null).
    record.limits.maxInputCharacters = num(model.max_characters_request_subscribed_user)
        ?? num(model.maximum_text_length_per_request);

    record.capabilities = {
        textToSpeech: model.can_do_text_to_speech !== false || null,
        voiceCloning: model.can_do_voice_conversion || null,
        audioOutput: category === 'tts' || category === 'sts' || null,
        textInput: category === 'tts' || null,
        speechToText: category === 'stt' || null,
        audioInput: category !== 'tts' || null,
        textOutput: category === 'stt' || null,
        realtime: realtime || null,
        automaticLanguageDetection: realtime || null,
        interimResults: realtime || null,
        finalResults: realtime || null,
        vad: realtime || null,
        endpointing: realtime || null,
    };

    if (realtime) {
        record.audio = {
            formats: ['pcm_16000'],
            sampleRates: [16000],
            channels: 1,
            pcm: true,
        };
    }

    record.pricing = {
        perCharacter: num(model.model_rates?.character_cost_multiplier),
        costFactor: num(model.token_cost_factor),
    };

    record.lifecycle.status = model.requires_alpha_access ? 'preview' : null;

    record.routing.languages = Array.isArray(model.languages) && model.languages.length
        ? model.languages.map(l => typeof l === 'string' ? l : l?.language_id).filter(Boolean)
        : null;
    record.routing.catalogMatch = catalogMatch ?? null;

    record.parameters = {
        style: typeof model.can_use_style === 'boolean' ? model.can_use_style : null,
        speakerBoost: typeof model.can_use_speaker_boost === 'boolean' ? model.can_use_speaker_boost : null,
        finetuning: typeof model.can_be_finetuned === 'boolean' ? model.can_be_finetuned : null,
    };

    // raw minus the large languages array (already normalized into routing.languages).
    const { languages, ...raw } = model;
    record.raw = raw;
    record.tier = 'standard';
    return finalizeCortexModel(record);
}
