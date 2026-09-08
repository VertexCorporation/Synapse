/*
 * Cortex Curator Worker - KV Storage Utilities (v2.3)
 * Manages all data mutations.
 * INCLUDES:
 * 1. "Structure Promotion" (String -> Object conversion).
 * 2. Extensive logging for debugging race conditions and data corruption.
 */

import { offlineGrouping, offlineEntries, putOffline } from '../../syncer/processing/offline.js';

const DATA_WRITE_LOCK_KEY = "data_write_lock";
const SYNCER_LOCK_KEY = "syncer_lock";
const LOCK_TTL_S = 60;

// --- Lock Helper Functions ---
async function acquireLock(locksKv, opId) {
    if (!locksKv) {
        console.warn(`[${opId}] [Lock] ⚠️ LOCKS KV not configured. Proceeding without lock (RISKY).`);
        return true;
    }

    console.log(`[${opId}] [Lock] Checking lock status...`);

    // 1. Check Syncer Lock
    const syncerHolder = await locksKv.get(SYNCER_LOCK_KEY);
    if (syncerHolder) {
        console.warn(`[${opId}] [Lock] ⛔ Blocked by Syncer (Holder: ${syncerHolder}).`);
        const syncError = new Error("System is currently syncing. Please wait 10-15 seconds.");
        syncError.status = 503;
        throw syncError;
    }

    // 2. Check Data Write Lock
    const currentHolder = await locksKv.get(DATA_WRITE_LOCK_KEY);
    if (currentHolder) {
        console.error(`[${opId}] [Lock] ⛔ Could not acquire lock. Held by: ${currentHolder}`);
        const lockError = new Error("Data is currently being modified by another admin process.");
        lockError.status = 409;
        throw lockError;
    }

    // 3. Acquire Lock
    await locksKv.put(DATA_WRITE_LOCK_KEY, opId, { expirationTtl: LOCK_TTL_S });
    console.log(`[${opId}] [Lock] ✅ Lock acquired successfully.`);
    return true;
}

async function releaseLock(locksKv, opId) {
    if (locksKv) {
        await locksKv.delete(DATA_WRITE_LOCK_KEY);
        console.log(`[${opId}] [Lock] 🔓 Lock released.`);
    }
}

// --- Read Operations ---
export async function getManualModels(kv) {
    if (!kv) throw new Error("KV namespace is not provided.");
    const list = await kv.list({ prefix: "model:" });
    if (list.keys.length === 0) return [];
    const promises = list.keys.map(key => kv.get(key.name, 'json'));
    const values = await Promise.all(promises);
    return values.filter(val => val).sort((a, b) => a.id.localeCompare(b.id));
}

// --- Delete Operation ---
export async function deleteManualModel(kv, locksKv, modelId, opId) {
    console.log(`[${opId}] [Delete] Request to delete model: ${modelId}`);
    await acquireLock(locksKv, opId);
    try {
        const listStr = await kv.get("list");
        if (!listStr) {
            console.warn(`[${opId}] [Delete] 'list.json' not found.`);
            return;
        }

        let data = JSON.parse(listStr);
        let found = false;

        for (const pName in data.producers) {
            if (data.producers[pName][modelId]) {
                console.log(`[${opId}] [Delete] Found model in list. Deleting...`);
                delete data.producers[pName][modelId];
                found = true;
                if (Object.keys(data.producers[pName]).length === 0) delete data.producers[pName];
                break;
            }
        }

        if (found) {
            const newVersion = new Date().toISOString();
            data.last_curator_update = opId;
            data.version = newVersion;

            await Promise.all([
                kv.put("list", JSON.stringify(data)),
                kv.put("version", newVersion),
                kv.delete(`model:${modelId}`)
            ]);
            console.log(`[${opId}] [Delete] ✅ Model deleted and list updated.`);
        } else {
            console.warn(`[${opId}] [Delete] Model ID not found in global list.`);
        }

    } finally {
        await releaseLock(locksKv, opId);
    }
}

/**
 * Enhanced Deep Merge.
 * If target is primitive and source is object, target is replaced.
 */
function mergeDeep(target, source) {
    if (!isObject(source)) return source;
    if (!isObject(target)) return { ...source };

    const output = { ...target };
    Object.keys(source).forEach(key => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;

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
    return output;
}

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

// --- Save/Create Operation ---
export async function saveManualModel(kv, locksKv, modelData, opId, isUpdate = false) {
    console.log(`[${opId}] [Save] Request to save/update model: ${modelData.id}`);
    await acquireLock(locksKv, opId);
    try {
        const { id, producer } = modelData;
        if (!id || !producer) {
            const e = new Error("Model data is missing required fields.");
            e.status = 400; throw e;
        }

        const listStr = await kv.get("list");
        let data = listStr ? JSON.parse(listStr) : { producers: {} };

        let finalModelObject;
        if (modelData.type === 'offline') {
            data.producers ??= {};
            const previous = [...offlineEntries(data.producers)].find(entry => entry.model.id === id && entry.model.source === 'manual');
            if (!isUpdate && previous) {
                const e = new Error(`Model with ID '${id}' already exists.`);
                e.status = 409; throw e;
            }
            finalModelObject = mergeDeep(previous?.model || {}, modelData);
            finalModelObject.source = 'manual';
            const location = finalModelObject.type === 'offline'
                ? offlineGrouping(finalModelObject)
                : { provider: producer, series: id, variant: 'Default' };
            if (previous) {
                delete data.producers[previous.p][previous.s][previous.v];
            }
            putOffline(data.producers, location, finalModelObject);
            if (previous) {
                const oldSeries = data.producers[previous.p][previous.s];
                if (!Object.values(oldSeries).some(value => value?.id)) {
                    const target = data.producers[location.provider][location.series];
                    for (const key of ['series_description', 'hidden']) {
                        if (oldSeries[key] !== undefined && target[key] === undefined) target[key] = oldSeries[key];
                    }
                    delete data.producers[previous.p][previous.s];
                    if (!Object.keys(data.producers[previous.p]).length) delete data.producers[previous.p];
                }
            }

        } else {
            if (!isUpdate && data.producers[producer]?.[id]) {
                console.error(`[${opId}] [Save] Conflict: Model already exists.`);
                const e = new Error(`Model with ID '${id}' already exists.`);
                e.status = 409; throw e;
            }

            const existingModel = data.producers?.[producer]?.[id]?.['Default'] || {};
            finalModelObject = mergeDeep(existingModel, modelData);

            data.producers[producer] = data.producers[producer] || {};
            data.producers[producer][id] = data.producers[producer][id] || {};
            data.producers[producer][id]['Default'] = finalModelObject;

        }

        const newVersion = new Date().toISOString();
        data.last_curator_update = opId;
        data.version = newVersion;

        await Promise.all([
            kv.put("list", JSON.stringify(data)),
            kv.put("version", newVersion),
            kv.put(`model:${id}`, JSON.stringify(finalModelObject))
        ]);

        console.log(`[${opId}] [Save] ✅ Successfully saved manual model '${id}'.`);

    } finally {
        await releaseLock(locksKv, opId);
    }
}

// --- Granular Update ---
/**
 * BATCH UPDATE FUNCTION (New)
 * Processes an array of updates in a SINGLE transaction to prevent race conditions.
 */
export async function updateModelsList(kv, locksKv, updatesArray, opId) {
    console.log(`[${opId}] [BatchUpdate] Processing ${updatesArray.length} updates...`);

    await acquireLock(locksKv, opId);
    try {
        const listStr = await kv.get("list");
        if (!listStr) { const e = new Error("Main list not found."); e.status = 404; throw e; }

        let data = JSON.parse(listStr);
        const modifiedManualModelIds = new Set();

        for (const payload of updatesArray) {
            const { pName, sName, vName, fieldPath, value } = payload;

            if (!pName || !sName || !fieldPath) continue;

            let targetModel = vName ? data.producers?.[pName]?.[sName]?.[vName] : null;

            if (!targetModel && fieldPath.startsWith('series_description')) {
            } else if (!targetModel && vName) {
                console.warn(`[${opId}] Target model not found: ${pName}/${sName}/${vName}`);
                continue;
            }

            if (targetModel) {
                const pathParts = fieldPath.split('.');
                const rootField = pathParts[0];
                if (targetModel[rootField] && typeof targetModel[rootField] === 'string' && pathParts.length > 1) {
                    console.log(`[${opId}] Promoting '${rootField}' to Object for ${targetModel.id}`);
                    targetModel[rootField] = { en: targetModel[rootField] };
                }
            }

            let updateObject = {};
            let current = updateObject;
            const keys = fieldPath.split('.');
            for (let i = 0; i < keys.length - 1; i++) {
                current[keys[i]] = {};
                current = current[keys[i]];
            }
            current[keys[keys.length - 1]] = value;

            if (vName) {
                data.producers[pName][sName][vName] = mergeDeep(data.producers[pName][sName][vName], updateObject);

                if (targetModel && targetModel.source === 'manual') {
                    modifiedManualModelIds.add(targetModel.id);
                }
            } else {
                data.producers[pName][sName] = mergeDeep(data.producers[pName][sName], updateObject);
            }
        }

        const manualModelPromises = [];
        for (const modelId of modifiedManualModelIds) {
            let foundModelData = null;

            const refUpdate = updatesArray.find(u => u.vName && data.producers[u.pName][u.sName][u.vName]?.id === modelId);
            if (refUpdate) {
                const latestModelData = data.producers[refUpdate.pName][refUpdate.sName][refUpdate.vName];
                console.log(`[${opId}] Syncing individual KV for manual model: ${modelId}`);
                manualModelPromises.push(kv.put(`model:${modelId}`, JSON.stringify(latestModelData)));
            }
        }

        const newVersion = new Date().toISOString();
        data.last_curator_update = opId;
        data.version = newVersion;

        await Promise.all([
            kv.put("list", JSON.stringify(data)),
            kv.put("version", newVersion),
            ...manualModelPromises
        ]);

        console.log(`[${opId}] [BatchUpdate] ✅ Success. Version: ${newVersion}`);

    } finally {
        await releaseLock(locksKv, opId);
    }
}
