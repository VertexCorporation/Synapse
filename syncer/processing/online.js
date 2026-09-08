/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Online Model Processor
 * Description: Fetches, filters, and processes models from the OpenRouter API.
 * Transforms the raw API data into our standardized 'ProducersData' structure.
 */

import { OPENROUTER_URL, ALLOWED_PROVIDER_IDS, TEXT_COST_LIMIT, IMAGE_COST_LIMIT, WEB_SEARCH_COST_LIMIT, PRODUCER_MAP } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';
import { isTooExpensive } from '../utils/helpers.js';
import { extractSeriesVariant } from './parser.js';

/**
 * @typedef {import('../types.js').ProducersData} ProducersData
 */

/**
 * Fetches models from OpenRouter, filters them, and builds a structured, grouped object.
 * @param {import('../types.js').Env} env - The environment bindings.
 * @param {string} operationId - The unique ID for the current sync operation.
 * @param {Set<string>} blacklistedIds - A set of model IDs to exclude from processing.
 * @returns {Promise<ProducersData>} A promise that resolves to the structured data of online models.
 */
export async function buildGroupedOnlineModels(env, operationId, blacklistedIds) {
    const opId = `${operationId}-online`;
    console.log(`🛠️ [${opId}] Starting online model processing...`);

    if (!env.OPENROUTER_KEY) {
        throw new Error(`[${opId}] OPENROUTER_KEY is not configured.`);
    }
    
    const response = await fetchWithTimeout(OPENROUTER_URL, { headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}` } }, env.FETCH_TIMEOUT_MS, opId);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[${opId}] OpenRouter API request failed with status ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const payload = await response.json();
    const models = payload?.data || [];
    if (models.length === 0) {
        throw new Error(`[${opId}] Sanity Check FAILED: OpenRouter API returned 0 models. Aborting.`);
    }
    console.log(`🔍 [${opId}] Fetched ${models.length} models from OpenRouter.`);

    /** @type {ProducersData} */
    const grouped = {};
    const fallbackGrouped = {};
    // Added 'imageGen' to stats to track filtered image generation models
    let stats = { kept: 0, fallback: 0, invalid: 0, blacklisted: 0, free: 0, provider: 0, cost: 0, research: 0, imageGen: 0, noSerVar: 0 };

    for (const model of models) {
        if (!model?.id || !model.name || !model.pricing || !model.architecture) {
            stats.invalid++;
            continue;
        }
        if (blacklistedIds.has(model.id)) {
            stats.blacklisted++;
            continue;
        }
        if (model.id.toLowerCase().includes("research")) {
             stats.research++;
             continue;
        }

        // --- NEW FILTER: Exclude models that output images ---
        // We check 'output_modalities'. If it includes "image", we skip this model.
        // This ensures models like 'Gemini Nano Banana' are excluded, while keeping models
        // that only take images as input (like GPT-4o).
        if (model.architecture.output_modalities && model.architecture.output_modalities.includes("image")) {
            stats.imageGen++;
            continue;
        }

        let isFallbackFree = false;
        if (model.id.toLowerCase().endsWith(":free")) {
            isFallbackFree = true;
            stats.free++;
            // We do not continue, we keep processing to add it to fallbackGrouped
        }

        const providerId = model.id.split("/")[0];
        if (!ALLOWED_PROVIDER_IDS.includes(providerId) && !isFallbackFree) {
            stats.provider++;
            continue;
        }
        if (isTooExpensive(model.pricing, TEXT_COST_LIMIT, IMAGE_COST_LIMIT, WEB_SEARCH_COST_LIMIT)) {
            if (!isFallbackFree) {
                stats.cost++;
                continue;
            }
        }

        const providerDisplayName = PRODUCER_MAP[providerId];
        const { series, variant } = extractSeriesVariant({ rawName: model.name, providerId, providerDisplayName }, opId);

        if (!series || !variant) {
            stats.noSerVar++;
            continue;
        }

        const p = model.pricing;
        const mArch = model.architecture;
        const description = model.description || model.name;

        // Determine modalities, outputs, reasoning, webSearch, tier
        const detailedModalities = { image: false, audio: false, file: false };
        if (mArch.input_modalities?.includes('image') || mArch.input_modalities?.includes('vision') || (p.image && +p.image > 0)) {
            detailedModalities.image = true;
        }
        if (mArch.input_modalities?.includes('audio')) {
            detailedModalities.audio = true;
        }
        if (mArch.input_modalities?.includes('file')) {
            detailedModalities.file = true;
        }

        const hasToolUse = model.supported_parameters?.includes('tools') || model.supported_parameters?.includes('tool_choice');
        const hasReasoning = model.supported_parameters?.includes('reasoning') || model.supported_parameters?.includes('include_reasoning');
        const supportsReasoning = hasToolUse || hasReasoning;

        const hasWebSearch = model.supported_parameters?.includes('web_search_options') || (p.web_search && +p.web_search > 0);

        const targetGrouped = isFallbackFree ? fallbackGrouped : grouped;

        targetGrouped[providerDisplayName] ??= {};
        targetGrouped[providerDisplayName][series] ??= {};
        targetGrouped[providerDisplayName][series][variant] = {
            id: model.id,
            source: 'openrouter',
            tier: isFallbackFree ? "fallback" : "standard",
            description: { en: description },
            context: model.context_length ?? 0,
            modalities: detailedModalities,
            // Since we filtered out image generators above, this will effectively always be false for kept models.
            outputs: {
                image: mArch.output_modalities?.includes('image') || false
            },
            reasoning: supportsReasoning,
            webSearch: hasWebSearch,
        };
        
        if (isFallbackFree) {
            stats.fallback++;
        } else {
            stats.kept++;
        }
    }

    console.log(`📊 [${opId}] Processed. Kept: ${stats.kept}, Fallbacks: ${stats.fallback}. Filters: Prov=${stats.provider}, Cost=${stats.cost}, ImgGen=${stats.imageGen}, Inv=${stats.invalid}, NoSerVar=${stats.noSerVar}`);
    return { grouped, fallbackGrouped };
}