/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Manual Model Processor
 * Description: Fetches, validates, and processes manually-added models from the KV namespace.
 * Includes a health check for model URLs to filter out unreachable ones.
 */

import { DEFAULTS } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';

/**
 * @typedef {import('../types.js').ProducersData} ProducersData
 * @typedef {import('../types.js').Env} Env
 */

/**
 * Fetches manual models from KV, validates their URLs, and formats them.
 * @param {KVNamespace} kv - The MODELS_JSON KV namespace.
 * @param {string} operationId - The unique ID for the current sync operation.
 * @returns {Promise<ProducersData>} A promise that resolves to the structured data of valid manual models.
 */
export async function processManualModels(kv, operationId) {
    const opId = `${operationId}-manual`;
    console.log(`[${opId}] Processing manual models from KV...`);
    
    let rawModels = [];
    try {
        const list = await kv.list({ prefix: "model:" });
        if (list.keys.length > 0) {
            const promises = list.keys.map(key => kv.get(key.name, 'json'));
            rawModels = (await Promise.all(promises)).filter(Boolean);
        }
    } catch (e) {
        console.error(`[${opId}] CRITICAL: Failed to fetch models from KV: ${e.message}`);
        return {};
    }

    if (rawModels.length === 0) {
        console.log(`[${opId}] No manual models found in KV.`);
        return {};
    }

    const checkPromises = rawModels.map(model => checkModelUrl(model, opId));
    const validModels = (await Promise.all(checkPromises)).filter(Boolean);
    console.log(`[${opId}] Found ${validModels.length} valid manual models (out of ${rawModels.length} total).`);

    /** @type {ProducersData} */
    const grouped = {};
    for (const model of validModels) {
        if (!model.id || !model.details?.en?.title) {
            console.warn(`[${opId}] Skipping manual model with invalid structure:`, JSON.stringify(model).substring(0, 150));
            continue;
        }
        const provider = model.producer || 'Vertex';
        const series = model.id;
        const variant = "Default";

        grouped[provider] ??= {};
        grouped[provider][series] ??= {};
        grouped[provider][series][variant] = {
            id: model.id, source: 'manual', tier: model.tier || 'free', type: model.type,
            ...(model.url && { url: model.url }), ...(model.imagePath && { imagePath: model.imagePath }),
            ...(model.size && { size: model.size }), ...(model.ram && { ram: model.ram }),
            details: model.details
        };
    }
    return grouped;
}

/**
 * Checks if a model's URL is accessible via a HEAD request.
 * @param {object} model - The model object.
 * @param {string} opId - The operation ID for logging.
 * @returns {Promise<object|null>} The model if its URL is valid or absent, otherwise null.
 */
async function checkModelUrl(model, opId) {
    if (!model?.url) return model; // No URL to check, model is valid.
    try {
        const res = await fetchWithTimeout(model.url, { method: 'HEAD' }, DEFAULTS.MANUAL_URL_CHECK_TIMEOUT_MS, opId);
        if (res.ok) return model;
        console.warn(`[${opId}] Skipping model "${model.id}" - URL check failed (Status: ${res.status}): ${model.url}`);
        return null;
    } catch (err) {
        console.warn(`[${opId}] Skipping model "${model.id}" - URL check error (${err.name}): ${model.url}`);
        return null;
    }
}