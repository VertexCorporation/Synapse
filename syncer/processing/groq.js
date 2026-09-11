/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Groq Model Processor
 * Description: Fetches and processes ultra-fast inference models from the Groq API.
 * Transforms models into Cortex ProducersData format.
 */

import { insertCatalogModel, matchCatalogModel } from './catalog-policy.js';
import { GROQ_URL } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';
import { normalizeModelId } from './dedup.js';
import { normalizeGroqModel } from './normalize/groq.js';

/**
 * Parses producer, series, and variant from Groq model ID.
 * e.g. "llama-3.3-70b-versatile" -> Producer: "Meta", Series: "Llama", Variant: "3.3 70B Versatile"
 * @param {string} modelId
 * @param {string} ownedBy
 * @returns {{producer: string, series: string, variant: string}}
 */
export function parseGroqModelIdentity(modelId, ownedBy) {
    const idLower = modelId.toLowerCase();
    let producer = "Groq";
    let series = "Groq";
    let variant = modelId.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    if (idLower.includes("llama")) {
        producer = "Meta";
        series = "Llama";
        variant = modelId.replace(/^llama-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || modelId;
    } else if (idLower.includes("qwen")) {
        producer = "Qwen";
        series = "Qwen";
        variant = modelId.replace(/^qwen-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || modelId;
    } else if (idLower.includes("gemma")) {
        producer = "Google";
        series = "Gemma";
        variant = modelId.replace(/^gemma-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || modelId;
    } else if (idLower.includes("deepseek")) {
        producer = "DeepSeek";
        series = "DeepSeek";
        variant = modelId.replace(/^deepseek-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || modelId;
    } else if (idLower.includes("mistral") || idLower.includes("mixtral")) {
        producer = "Mistral AI";
        series = idLower.includes("mixtral") ? "Mixtral" : "Mistral";
        variant = modelId.replace(/^(mistral|mixtral)-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || modelId;
    } else if (idLower.includes("whisper")) {
        producer = "OpenAI";
        series = "Whisper";
        variant = modelId.replace(/^whisper-?/i, "").replace(/[-_]/g, " ").trim() || modelId;
    } else if (ownedBy) {
        producer = ownedBy.charAt(0).toUpperCase() + ownedBy.slice(1);
    }

    return { producer, series, variant };
}

/**
 * Fetches all models from Groq API.
 * @param {import('../types.js').Env} env
 * @param {string} operationId
 * @param {Set<string>} blacklistedIds
 * @returns {Promise<{grouped: object}>}
 */
export async function buildGroupedGroqModels(env, operationId, blacklistedIds) {
    const opId = `${operationId}-groq`;
    console.log(`⚡ [${opId}] Starting Groq model fetching...`);

    const apiKey = env.GROQ_API_KEY || env.GROQ_KEY;
    if (!apiKey) {
        console.warn(`⚠️ [${opId}] GROQ_API_KEY is not configured. Skipping Groq.`);
        return { grouped: {} };
    }

    const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
    };

    const grouped = {};
    const records = [];
    let kept = 0;

    try {
        const response = await fetchWithTimeout(GROQ_URL, { headers }, env.FETCH_TIMEOUT_MS || 30000, opId);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq API failed with status ${response.status}: ${errText.substring(0, 150)}`);
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];

        for (const model of models) {
            const modelId = model.id;
            if (!modelId || !matchCatalogModel('groq', modelId)) {
                if (modelId) console.warn(`🚨 [${opId}] ALARM[asset-missing]: groq model "${modelId}" has no catalog asset match; excluded.`);
                continue;
            }
            if (model.active === false) continue;
            if (blacklistedIds && blacklistedIds.has(modelId)) continue;

            const isVision = modelId.toLowerCase().includes("vision");
            const isAudio = modelId.toLowerCase().includes("whisper");
            const { producer, series, variant } = parseGroqModelIdentity(modelId, model.owned_by);
            const features = Array.isArray(model.supported_features) ? model.supported_features : [];

            // Catalog record: canonical CortexModel with truthful limits/capabilities.
            records.push(normalizeGroqModel(model, {
                identity: { producer, series, variant },
                canonicalKey: normalizeModelId(modelId, 'groq'),
                catalogMatch: matchCatalogModel('groq', modelId),
            }));

            insertCatalogModel(grouped, producer, series, variant, {
                id: modelId,
                source: "groq",
                tier: "standard",
                description: { en: `Groq ultra-fast LPU inference for ${modelId}` },
                // Truthful context: null-safe (never the legacy invented 8192 default).
                context: model.context_window ?? 0,
                modalities: {
                    image: isVision,
                    video: false,
                    audio: isAudio,
                    file: false,
                },
                outputs: {
                    image: false,
                    video: false,
                    audio: false,
                },
                // Agentic capability = declared tools/reasoning features (no blanket true).
                reasoning: features.includes("tools") || features.includes("reasoning"),
                webSearch: false,
            });
            kept++;
        }

        console.log(`⚡ [${opId}] Groq models complete: kept ${kept} models.`);
        return { grouped, records, health: { ok: true, count: models.length, kept } };
    } catch (e) {
        console.warn(`⚠️ [${opId}] Groq fetching failed: ${e.message}`);
        return { grouped, records, health: { ok: false, error: e.message } };
    }
}
