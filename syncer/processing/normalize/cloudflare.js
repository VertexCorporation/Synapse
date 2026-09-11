/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Cloudflare Workers AI Normalizer (normalize/cloudflare.js)
 * Description: Maps a Cloudflare /ai/models/search entry to a canonical
 * CortexModel. Fixes the legacy properties bug: the API returns `properties`
 * as an ARRAY of {property_id, value} pairs (legacy code read it as an object,
 * so context was always 0). Context now comes from the `context_window`
 * property; unknown stays null, never 0.
 *
 * Note: the CF list endpoint exposes no deprecation attribute, so deprecated
 * models are not ingested (default API filter) and lifecycle.deprecated stays
 * null until CF exposes a marker.
 */

import { createCortexModel, prov, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';
import { categoryFromTaskName } from './tasks.js';

/**
 * Converts the Cloudflare `properties` array into a plain map.
 * Tolerates the legacy object shape if CF ever returns it.
 * @returns {object} e.g. { context_window: "128000", function_calling: "true", price: [...] }
 */
export function cloudflareProperties(item) {
    const properties = item?.properties;
    if (Array.isArray(properties)) {
        const map = {};
        for (const entry of properties) {
            if (entry?.property_id) map[entry.property_id] = entry.value;
        }
        return map;
    }
    return properties && typeof properties === 'object' ? properties : {};
}

function positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function toIso(dateText) {
    if (!dateText || typeof dateText !== 'string') return null;
    try {
        // CF format: "2025-08-05 10:27:29.131" (UTC, space-separated)
        const date = new Date(`${dateText.replace(' ', 'T')}Z`);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch { return null; }
}

/** Reads the per-million-token price rows from the CF price property. */
function tokenPrices(priceProperty) {
    const rows = Array.isArray(priceProperty) ? priceProperty : [];
    const pick = label => {
        const row = rows.find(r => String(r?.unit || '').toLowerCase().includes(label));
        return row && Number.isFinite(Number(row.price)) ? Number(row.price) / 1_000_000 : null;
    };
    return { input: pick('input'), output: pick('output') };
}

/**
 * @param {object} item - Raw CF model entry (name, task, properties[]).
 * @param {{identity: {producer: string, series: string, variant: string}, canonicalKey: string,
 *          catalogMatch: object|null, modalities: {image: boolean, video: boolean, audio: boolean, file: boolean},
 *          outputs: {image: boolean, video: boolean, audio: boolean}}} ctx - Processor-computed placement & modality facts.
 */
export function normalizeCloudflareModel(item, { identity, canonicalKey, catalogMatch, modalities, outputs }) {
    const modelId = item.name || item.id;
    const category = categoryFromTaskName(item.task?.name);
    const props = cloudflareProperties(item);
    const record = createCortexModel({ id: modelId, source: 'cloudflare', canonicalKey, category });

    record.identity = identityFrom({
        id: modelId,
        displayName: modelId.split('/').pop(),
        producer: identity.producer,
        series: identity.series,
        variant: identity.variant,
    });
    record.lifecycle.createdAt = toIso(item.created_at);

    record.modalities = {
        input: ['text', modalities?.image && 'image', modalities?.video && 'video', modalities?.audio && 'audio'].filter(Boolean),
        // Every CF task produces text unless it is text-to-image or text-to-speech.
        output: [!outputs?.image && !outputs?.audio && 'text', outputs?.image && 'image', outputs?.video && 'video', outputs?.audio && 'audio'].filter(Boolean),
        architectureModality: null,
    };

    // The fix: context from the properties ARRAY. No 0 invention.
    record.limits.contextTokens = positiveNumber(props.context_window ?? props.max_context);

    const prices = tokenPrices(props.price);
    record.pricing = { currency: 'USD', inputPerToken: prices.input, outputPerToken: prices.output };

    record.capabilities = {
        chat: category === 'chat' || null,
        // Task "Text Generation" does NOT imply reasoning — only the explicit property does.
        reasoning: props.reasoning === 'true' ? prov(true, 'cloudflare') : (props.reasoning === 'false' ? prov(false, 'cloudflare') : null),
        tools: props.function_calling === 'true' ? prov(true, 'cloudflare') : null,
        vision: modalities?.image || null,
        speechToText: category === 'stt' || null,
        textToSpeech: category === 'tts' || null,
        imageGeneration: category === 'image-gen' || null,
        embeddings: category === 'embedding' || null,
        translation: category === 'translation' || null,
        imageInput: modalities?.image || null,
        audioInput: modalities?.audio || null,
        imageOutput: outputs?.image || null,
        audioOutput: outputs?.audio || null,
    };

    record.routing.catalogMatch = catalogMatch ?? null;
    record.raw = item;
    record.tier = 'standard';
    return finalizeCortexModel(record);
}
