/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Manual Model Processor
 * Description: Fetches, validates, and processes manually-added models from the KV namespace.
 * Includes a health check for model URLs to filter out unreachable ones.
 */

import { offlineGrouping } from './offline.js';
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
        // KV içerisindeki 'model:' ile başlayan tüm kayıtları çeker
        let cursor;
        do {
            const list = await kv.list({ prefix: "model:", ...(cursor ? { cursor } : {}) });
            rawModels.push(...(await Promise.all(list.keys.map(key => kv.get(key.name, 'json')))).filter(Boolean));
            cursor = list.list_complete ? undefined : list.cursor;
        } while (cursor);
    } catch (e) {
        console.error(`[${opId}] CRITICAL: Failed to fetch models from KV: ${e.message}`);
        return {};
    }

    if (rawModels.length === 0) {
        console.log(`[${opId}] No manual models found in KV.`);
        return {};
    }

    // URL kontrolü (Health check)
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
        
        // Eğer producer belirtilmemişse varsayılan olarak Vertex
        const { provider, series, variant: baseVariant } = model.type === 'offline'
            ? offlineGrouping(model)
            : { provider: model.producer || 'Vertex', series: model.id, variant: 'Default' };
        const variant = grouped[provider]?.[series]?.[baseVariant]
            ? `${baseVariant} [${model.id}]` : baseVariant;

        grouped[provider] ??= {};
        grouped[provider][series] ??= {};
        
        // BURASI DEĞİŞTİRİLDİ: Eksik alanlar (chatFormat, licenseInfo vb.) eklendi.
        grouped[provider][series][variant] = {
            id: model.id,
            source: 'manual',
            tier: model.tier || 'free',
            type: model.type,
            
            // Temel Bilgiler
            ...(model.url && { url: model.url }),
            ...(model.imagePath && { imagePath: model.imagePath }),
            ...(model.size && { size: model.size }),
            ...(model.ram && { ram: model.ram }),
            
            // Offline Mod ve UI için Kritik Alanlar
            ...(model.chatFormat && { chatFormat: model.chatFormat }),
            ...(model.licenseInfo && { licenseInfo: model.licenseInfo }),
            ...(model.modalities && { modalities: model.modalities }),
            ...(model.outputs && { outputs: model.outputs }),
            ...(model.producer && { producer: model.producer }), // Producer'ı obje içine de ekleyelim
            
            // Detaylar (i18n vb.)
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
    if (!model?.url) return model; 
    try {
        const res = await fetchWithTimeout(model.url, { method: 'HEAD' }, DEFAULTS.MANUAL_URL_CHECK_TIMEOUT_MS, opId);
 
        if (res.ok) return model;

        if (res.status === 404 || res.status === 410) {
            console.warn(`[${opId}] DELETE DECISION: Model "${model.id}" removed because link is dead (Status: ${res.status}): ${model.url}`);
            return null; 
        }

        console.warn(`[${opId}] KEEPING Model "${model.id}" despite error (Status: ${res.status}). Assuming temporary issue.`);
        return model; 

    } catch (err) {
        console.warn(`[${opId}] KEEPING Model "${model.id}" despite network error (${err.name}).`);
        return model;
    }
}