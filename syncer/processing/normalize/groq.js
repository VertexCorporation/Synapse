/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Groq Normalizer (normalize/groq.js)
 * Description: Maps a Groq /openai/v1/models entry to a canonical CortexModel.
 * Fixes the legacy overwrites: no invented 8192 context, no blanket
 * reasoning:true, and separate docs-provenanced reasoning details.
 */

import { createCortexModel, prov, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';
import { categoryFromGroqId, normalizeModalityList } from './tasks.js';
import { groqReasoningDocs, isGroqCompound } from '../../config/provider-docs.js';

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toUnixIso(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return null;
    try { return new Date(n * 1000).toISOString(); } catch { return null; }
}

/**
 * @param {object} model - Raw Groq model entry.
 * @param {{identity: {producer: string, series: string, variant: string}, canonicalKey: string,
 *          catalogMatch: object|null}} ctx
 */
export function normalizeGroqModel(model, { identity, canonicalKey, catalogMatch }) {
    const category = categoryFromGroqId(model.id);
    const record = createCortexModel({ id: model.id, source: 'groq', canonicalKey, category });
    record.identity = identityFrom({
        id: model.id,
        displayName: model.name,
        producer: identity.producer,
        series: identity.series,
        variant: identity.variant,
        huggingFaceId: model.hugging_face_id,
    });
    record.lifecycle.createdAt = toUnixIso(model.created);
    // Groq exposes `active`; an inactive model is deprecated.
    record.lifecycle.deprecated = model.active === false ? prov(true, 'groq') : null;
    record.lifecycle.status = model.active === false ? 'deprecated' : null;

    record.modalities = {
        input: normalizeModalityList(model.input_modalities),
        output: normalizeModalityList(model.output_modalities, true),
        architectureModality: null,
    };

    // Never default to 8192 — unknown context stays null.
    record.limits.contextTokens = Number.isFinite(Number(model.context_window)) ? Number(model.context_window) : null;
    record.limits.maxOutputTokens = num(model.max_completion_tokens) ?? num(model.max_output_length);

    const features = Array.isArray(model.supported_features) ? model.supported_features : null;
    const docs = groqReasoningDocs(model.id);
    const reasoningSupported = features ? (features.includes('reasoning') || !!docs) : (docs ? true : null);

    record.capabilities = {
        chat: category === 'chat',
        reasoning: features ? prov(features.includes('reasoning') || !!docs, 'groq') : (docs ? prov(true, 'docs', 0.9) : null),
        tools: features ? prov(features.includes('tools'), 'groq') : null,
        streaming: category === 'chat' ? prov(true, 'docs', 0.9) : null, // Groq streams chat completions
        structuredOutput: features ? (features.includes('structured_outputs') || features.includes('json_mode') || null) : null,
        webSearch: isGroqCompound(model.id) ? prov(true, 'docs', 0.95) : null, // compound runs web search + code execution
        speechToText: category === 'stt' || null,
        audioInput: category === 'stt' || null,
        textToSpeech: category === 'tts' || null,
        audioOutput: category === 'tts' || null,
        textOutput: true, // every Groq completion (chat, STT transcript, guard label) is text
        moderation: category === 'moderation' || null,
        vision: /vision/i.test(String(model.id)) ? prov(true, 'heuristic', 0.5) : null,
    };

    record.reasoning = {
        supported: reasoningSupported,
        mandatory: docs?.mandatory ?? null,
        efforts: docs?.efforts ?? null,
        defaultEffort: docs?.defaultEffort ?? null,
    };

    record.pricing = {
        currency: 'USD',
        inputPerToken: num(model.pricing?.prompt),
        outputPerToken: num(model.pricing?.completion),
        cachedInputPerToken: num(model.pricing?.input_cache_read),
        request: num(model.pricing?.request),
        image: num(model.pricing?.image),
    };

    const sampling = Array.isArray(model.supported_sampling_parameters) ? model.supported_sampling_parameters : [];
    record.parameters = Object.fromEntries(sampling.map(key => [key, true]));

    record.routing.catalogMatch = catalogMatch ?? null;
    // raw without public_apps noise.
    const { public_apps, ...raw } = model;
    record.raw = raw;

    record.tier = 'standard';
    return finalizeCortexModel(record);
}
