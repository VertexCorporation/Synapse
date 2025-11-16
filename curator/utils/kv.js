/*
 * Cortex Curator Worker - KV Storage Utilities (v2.0)
 * Manages all data mutations in a locked, transactional manner.
 */

const DATA_WRITE_LOCK_KEY = "data_write_lock";
const LOCK_TTL_S = 20; // Short-term lock for atomic operations

// --- Lock Helper Functions ---
async function acquireLock(locksKv, opId) {
    if (!locksKv) {
        console.warn(`[${opId}] LOCKS KV not configured. Proceeding without lock (RISKY).`);
        return true;
    }
    const currentHolder = await locksKv.get(DATA_WRITE_LOCK_KEY);
    if (currentHolder) {
        console.error(`[${opId}] Could not acquire lock. Held by: ${currentHolder}`);
        const lockError = new Error("Data is currently being modified by another process. Please try again in a moment.");
        lockError.status = 409; // HTTP 409 Conflict
        throw lockError;
    }
    await locksKv.put(DATA_WRITE_LOCK_KEY, opId, { expirationTtl: LOCK_TTL_S });
    return true;
}

async function releaseLock(locksKv, opId) {
    if (locksKv) {
        await locksKv.delete(DATA_WRITE_LOCK_KEY);
        console.log(`[${opId}] Lock released.`);
    }
}

// This function reads the individual `model:*` keys for the public GET endpoint.
export async function getManualModels(kv) {
    if (!kv) {
        throw new Error("KV namespace is not provided.");
    }
    const list = await kv.list({ prefix: "model:" });
    if (list.keys.length === 0) {
        return [];
    }
    const promises = list.keys.map(key => kv.get(key.name, 'json'));
    const values = await Promise.all(promises);
    return values.filter(val => val).sort((a, b) => a.id.localeCompare(b.id));
}

// --- deleteManualModel (Write Operation) ---
export async function deleteManualModel(kv, locksKv, modelId, opId) {
    await acquireLock(locksKv, opId);
    try {
        const listStr = await kv.get("list");
        if (!listStr) return; // If list doesn't exist, nothing to delete.

        let data = JSON.parse(listStr);
        let found = false;

        for (const pName in data.producers) {
            if (data.producers[pName][modelId]) {
                delete data.producers[pName][modelId];
                found = true;
                if (Object.keys(data.producers[pName]).length === 0) {
                    delete data.producers[pName];
                }
                break;
            }
        }
        
        if (found) {
            const newVersion = new Date().toISOString();
            data.last_curator_update = opId;
            data.version = newVersion;
            await kv.put("list", JSON.stringify(data));
            await kv.put("version", newVersion);
        }
        
        await kv.delete(`model:${modelId}`);

    } finally {
        await releaseLock(locksKv, opId);
    }
}

/**
 * Deeply merges two objects. Properties from `source` will overwrite properties in `target`.
 * Unlike a simple spread operator, this merges nested objects instead of replacing them.
 * @param {object} target The object to merge into.
 * @param {object} source The object to merge from.
 * @returns {object} The new, deeply merged object.
 */
function mergeDeep(target, source) {
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            // Prototype Pollution koruması
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                return;
            }
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = mergeDeep(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

/**
 * Helper to check if a variable is a non-null object.
 * @param {*} item The variable to check.
 */
function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

// --- saveManualModel ---
export async function saveManualModel(kv, locksKv, modelData, opId, isUpdate = false) {
    await acquireLock(locksKv, opId);
    try {
        const { id, producer } = modelData;
        
        if (!id || !producer || !modelData.details?.en?.title || !modelData.type) {
             const err = new Error("Model data is missing required fields.");
             err.status = 400;
             throw err;
        }

        const listStr = await kv.get("list");
        let data = listStr ? JSON.parse(listStr) : { producers: {} };

        if (!isUpdate && data.producers[producer]?.[id]) {
            const conflictError = new Error(`Model with ID '${id}' already exists.`);
            conflictError.status = 409;
            throw conflictError;
        }
        
        // Mevcut modeli al (varsa)
        const existingModel = data.producers?.[producer]?.[id]?.['Default'] || {};
        
        // Gelen yeni veriyi, mevcut verinin üzerine akıllıca birleştir.
        const finalModelObject = mergeDeep(existingModel, modelData);

        data.producers[producer] = data.producers[producer] || {};
        data.producers[producer][id] = data.producers[producer][id] || {};
        data.producers[producer][id]['Default'] = finalModelObject;
        
        const newVersion = new Date().toISOString();
        data.last_curator_update = opId;
        data.version = newVersion;

        await Promise.all([
            kv.put("list", JSON.stringify(data)),
            kv.put("version", newVersion),
            kv.put(`model:${id}`, JSON.stringify(finalModelObject))
        ]);

        console.log(`[${opId}] Successfully saved/updated manual model '${id}'.`);

    } finally {
        await releaseLock(locksKv, opId);
    }
}


// --- Granular Update Function (Write Operation) ---
export async function updateModelsList(kv, locksKv, payload, opId) {
    await acquireLock(locksKv, opId);
    try {
        const { pName, sName, vName, fieldPath, value } = payload;
        if (!pName || !sName || !fieldPath) {
             const err = new Error("Missing required fields for granular update.");
             err.status = 400;
             throw err;
        }

        const listStr = await kv.get("list");
        if (!listStr) {
            const err = new Error("Main list not found. Cannot update.");
            err.status = 404;
            throw err;
        }

        let data = JSON.parse(listStr);
        
        let targetModel = vName ? data.producers?.[pName]?.[sName]?.[vName] : null;
        let isManualModelUpdate = targetModel && targetModel.source === 'manual';

        let updateObject = {};
        let current = updateObject;
        const keys = fieldPath.split('.');
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            current[key] = {};
            current = current[key];
        }
        current[keys[keys.length - 1]] = value;

        if (vName) {
            data.producers[pName][sName][vName] = mergeDeep(data.producers[pName][sName][vName], updateObject);
        } else {
             data.producers[pName][sName] = mergeDeep(data.producers[pName][sName], updateObject);
        }

        if (isManualModelUpdate) {
            const modelId = targetModel.id;
            const updatedModelData = data.producers[pName][sName][vName];
            console.log(`[${opId}] Granular update for manual model '${modelId}'. Syncing individual KV entry.`);
            await kv.put(`model:${modelId}`, JSON.stringify(updatedModelData));
        }

        const newVersion = new Date().toISOString();
        data.last_curator_update = opId;
        data.version = newVersion;
        
        await kv.put("list", JSON.stringify(data));
        await kv.put("version", newVersion);

    } finally {
        await releaseLock(locksKv, opId);
    }
}