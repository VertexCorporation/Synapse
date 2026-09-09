/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: OpenRouter Normalizer (normalize/openrouter.js)
 * Description: Maps an OpenRouter /api/v1/models entry to a canonical
 * CortexModel. Unknowns stay null — never 0 / false — and every derived fact
 * is a provenance triplet.
 */

import { createCortexModel, prov, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';
import { normalizeModalityList } from './tasks.js';

const PARAM_KEYS = [
    'temperature', 'top_p', 'top_k', 'seed', 'stop', 'max_tokens', 'max_completion_tokens',
    'tools', 'tool_choice', 'response_format', 'structured_outputs', 'reasoning', 'reasoning_effort',
    'include_reasoning', 'logprobs', 'frequency_penalty', 'presence_penalty', 'web_search_options',
];

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
 * @param {object} model - Raw OpenRouter model entry.
 * @param {{identity: {producer: string, series: string, variant: string}, canonicalKey: string,
 *          tier: string, catalogMatch: object|null}} ctx - Processor-parsed placement.
 * @returns {object} Finalized CortexModel.
 */
export function normalizeOpenRouterModel(model, { identity, canonicalKey, tier, catalogMatch }) {
    const isEmbedding = model.architecture?.modality === 'embeddings' || /embedding/i.test(String(model.id));
    const record = createCortexModel({
        id: model.id,
        source: 'openrouter',
        canonicalKey,
        category: isEmbedding ? 'embedding' : 'chat',
    });
    record.identity = identityFrom({
        id: model.id,
        displayName: model.name,
        producer: identity.producer,
        series: identity.series,
        variant: identity.variant,
        huggingFaceId: model.hugging_face_id,
    });
    record.lifecycle.createdAt = toUnixIso(model.created);
    record.lifecycle.knowledgeCutoff = model.knowledge_cutoff || null;
    record.lifecycle.expiresAt = model.expiration_date || null;

    record.modalities = {
        input: normalizeModalityList(model.architecture?.input_modalities),
        output: normalizeModalityList(model.architecture?.output_modalities, true),
        architectureModality: model.architecture?.modality || null,
    };

    // Limits: never default. `context_length: 0` would be a provider-declared fact.
    record.limits.contextTokens = Number.isFinite(Number(model.context_length)) ? Number(model.context_length) : null;
    record.limits.maxOutputTokens = num(model.top_provider?.max_completion_tokens);

    const pricing = model.pricing || {};
    record.pricing = {
        currency: 'USD',
        inputPerToken: num(pricing.prompt),
        outputPerToken: num(pricing.completion),
        cachedInputPerToken: num(pricing.input_cache_read),
        request: num(pricing.request),
        image: num(pricing.image),
        webSearch: num(pricing.web_search),
        internalReasoningPerToken: num(pricing.internal_reasoning),
        free: tier === 'fallback',
    };

    const sp = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    const hasReasoning = sp.includes('reasoning') || sp.includes('include_reasoning');
    const hasTools = sp.includes('tools') || sp.includes('tool_choice');
    // supported_parameters is the provider-declared capability list: absence == false.
    record.capabilities = {
        chat: !isEmbedding,
        reasoning: prov(hasReasoning, 'openrouter'),
        tools: prov(hasTools, 'openrouter'),
        streaming: prov(true, 'docs', 0.9), // OpenRouter streams every chat completion
        structuredOutput: sp.includes('structured_outputs') || sp.includes('response_format') || null,
        webSearch: sp.includes('web_search_options') || null,
        ...Object.fromEntries(Object.entries(record.capabilities)
            .filter(([key]) => !['chat', 'reasoning', 'tools', 'streaming', 'structuredOutput', 'webSearch'].includes(key))
            .map(([key]) => [key, null])),
    };
    // Modality-derived facts (plain, provider-declared).
    if (record.modalities.input.includes('image')) record.capabilities.imageInput = record.capabilities.vision = true;
    if (record.modalities.input.includes('audio')) record.capabilities.audioInput = true;
    if (record.modalities.input.includes('file')) record.capabilities.fileInput = true;
    if (record.modalities.output.includes('text')) record.capabilities.textOutput = true;

    record.reasoning = { supported: hasReasoning || null, mandatory: null, efforts: null, defaultEffort: null };
    record.routing.isModerated = model.top_provider?.is_moderated ?? null;
    record.routing.catalogMatch = catalogMatch ?? null;

    record.parameters = Object.fromEntries(PARAM_KEYS.filter(key => sp.includes(key)).map(key => [key, true]));

    // Execution-mode classification: batch-only models must not enter interactive
    // chat pools. Explicit provider metadata takes priority; "batch" in the id
    // is the fallback heuristic.
    const explicitBatchOnly = model.top_provider?.batch_only === true || model.batch_only === true;
    const nameImpliesBatch = /\bbatch\b/i.test(String(model.id)) || /\bbatch\b/i.test(String(model.name));
    const isBatchOnly = explicitBatchOnly || nameImpliesBatch;
    record.executionModes.supportsBatch = prov(isBatchOnly || null, isBatchOnly ? (explicitBatchOnly ? 'openrouter' : 'heuristic') : null, explicitBatchOnly ? 1 : 0.85);
    record.executionModes.supportsInteractive = prov(isBatchOnly ? false : true, isBatchOnly ? (explicitBatchOnly ? 'openrouter' : 'heuristic') : 'openrouter', isBatchOnly ? (explicitBatchOnly ? 1 : 0.85) : 1);

    // raw: provider payload minus the long description (already served via the producers tree).
    const { description, ...raw } = model;
    record.raw = raw;

    record.tier = tier;
    return finalizeCortexModel(record);
}
