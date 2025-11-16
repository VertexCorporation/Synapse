/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Online Model Processor
 * Description: Fetches, filters, and processes models from the OpenRouter API.
 * Transforms the raw API data into our standardized 'ProducersData' structure.
 */

import { OPENROUTER_URL, ALLOWED_PROVIDER_IDS, TEXT_COST_LIMIT, IMAGE_COST_LIMIT, WEB_SEARCH_COST_LIMIT, PRODUCER_MAP, TIER_THRESHOLDS } from '../config.js';
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
    let stats = { kept: 0, invalid: 0, blacklisted: 0, free: 0, provider: 0, cost: 0, noSerVar: 0 };

    for (const model of models) {
        if (!model?.id || !model.name || !model.pricing || !model.architecture) {
            stats.invalid++;
            continue;
        }
        if (blacklistedIds.has(model.id)) {
            stats.blacklisted++;
            continue;
        }
        if (model.id.endsWith(":free")) {
            stats.free++;
            continue;
        }

        const providerId = model.id.split("/")[0];
        if (!ALLOWED_PROVIDER_IDS.includes(providerId)) {
            stats.provider++;
            continue;
        }
        if (isTooExpensive(model.pricing, TEXT_COST_LIMIT, IMAGE_COST_LIMIT, WEB_SEARCH_COST_LIMIT)) {
            stats.cost++;
            continue;
        }

        const providerDisplayName = PRODUCER_MAP[providerId];
        const { series, variant } = extractSeriesVariant({ rawName: model.name, providerId, providerDisplayName }, opId);

        if (!series || !variant) {
            stats.noSerVar++;
            continue;
        }

        const p = model.pricing;
        const mArch = model.architecture;
        const mCaps = model.capabilities || {};
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
        let tier = "free";
        if ((p.image && +p.image >= TIER_THRESHOLDS.IMAGE_PREMIUM) || (p.completion && +p.completion >= TIER_THRESHOLDS.TEXT_PREMIUM)) {
            tier = "premium";
        }

        grouped[providerDisplayName] ??= {};
        grouped[providerDisplayName][series] ??= {};
        grouped[providerDisplayName][series][variant] = {
            id: model.id,
            source: 'openrouter',
            tier: tier,
            description: { en: description },
            context: model.context_length ?? 0,
            modalities: detailedModalities,
            outputs: {
                image: mArch.output_modalities?.includes('image') || false
            },
            reasoning: supportsReasoning,
            webSearch: hasWebSearch,
        };
        stats.kept++;
    }

    console.log(`📊 [${opId}] Processed. Kept: ${stats.kept}. Filters: Prov=${stats.provider}, Cost=${stats.cost}, Free=${stats.free}, Inv=${stats.invalid}, NoSerVar=${stats.noSerVar}`);
    return grouped;
}