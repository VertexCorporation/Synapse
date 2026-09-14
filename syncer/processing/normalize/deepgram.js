/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Deepgram Normalizer (normalize/deepgram.js)
 * Description: Maps Deepgram /v1/models entries (stt + tts sections) to
 * canonical CortexModels. contextTokens is never fabricated (audio models
 * have no token window) — streaming/batch flags come straight from the API.
 */

import { createCortexModel, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';

/**
 * @param {object} model - Raw Deepgram entry from the stt or tts array.
 * @param {{kind: 'stt'|'tts', identity: {producer: string, series: string, variant: string},
 *          canonicalKey: string, catalogMatch: object|null}} ctx
 */
export function normalizeDeepgramModel(model, { kind, identity, canonicalKey, catalogMatch }) {
    const modelId = model.canonical_name || model.name;
    const realtime = kind === 'stt' && model.streaming !== false;
    const record = createCortexModel({
        id: modelId,
        source: 'deepgram',
        canonicalKey,
        category: kind === 'stt' ? 'stt' : 'tts',
        task: realtime ? 'realtime_stt' : null,
    });

    record.identity = identityFrom({
        id: modelId,
        displayName: model.name || modelId,
        producer: identity.producer,
        series: identity.series,
        variant: identity.variant,
        version: model.version || null,
    });

    record.modalities = {
        input: kind === 'stt' ? ['audio'] : ['text'],
        output: kind === 'stt' ? ['text'] : ['audio'],
        architectureModality: null,
    };

    record.capabilities = {
        speechToText: kind === 'stt' || null,
        textToSpeech: kind === 'tts' || null,
        audioInput: kind === 'stt' || null,
        textInput: kind === 'tts' || null,
        audioOutput: kind === 'tts' || null,
        textOutput: kind === 'stt' || null,
        // Streaming/batch are provider-declared booleans in the API response.
        streaming: typeof model.streaming === 'boolean' ? model.streaming : null,
        realtime: typeof model.streaming === 'boolean' ? model.streaming : null,
        automaticLanguageDetection: kind === 'stt' && model.multilingual === true ? true : null,
        interimResults: realtime ? true : null,
        finalResults: realtime ? true : null,
        vad: realtime ? true : null,
        endpointing: realtime ? true : null,
    };
    if (typeof model.batch === 'boolean') record.parameters = { batch: model.batch };
    if (typeof model.multilingual === 'boolean') record.capabilities.multilingual = model.multilingual;

    record.routing.languages = Array.isArray(model.languages) && model.languages.length ? model.languages : null;
    record.routing.catalogMatch = catalogMatch ?? null;
    if (kind === 'stt') {
        record.audio = {
            formats: ['linear16'],
            sampleRates: [16000],
            channels: 1,
            pcm: true,
        };
    }

    record.raw = model;
    record.tier = 'standard';
    return finalizeCortexModel(record);
}
