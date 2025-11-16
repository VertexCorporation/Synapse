/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Core Sync Logic
 * Description: Orchestrates the entire model synchronization process.
 * This is the main business logic controller for the scheduled task.
 */

import { acquireLock, releaseLock } from '../kv/lock.js';
import { readCurrentData, createBackups, writeNewData } from '../kv/data.js';
import { processManualModels } from '../processing/manual.js';
import { buildGroupedOnlineModels } from '../processing/online.js'; // Will create in next step
import { rehydrateAndMergeProducers } from '../processing/merge.js'; // Will create in next step
import { hashJson, mergeDeep } from '../utils/helpers.js';

const LOCK_KEY = "syncer_lock";
const DATA_WRITE_LOCK_KEY = "data_write_lock";

/**
 * The main synchronization function that runs on a schedule.
 * @param {object} env - The environment object containing bindings.
 * @param {object} context - The worker execution context.
 */
export async function syncModels(env, context) {
    const opId = `sync-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    console.log(`🔄 [${opId}] Starting sync process...`);

    const MODELS_KV = env.MODELS_JSON;
    if (!MODELS_KV?.put) {
        console.error(`❌ [${opId}] MODELS_JSON KV is invalid.`);
        throw new Error("MODELS_JSON KV is invalid.");
    }

    const dataWriteLockHolder = await env.LOCKS?.get(DATA_WRITE_LOCK_KEY);
    if (dataWriteLockHolder) {
        console.log(`🔶 [${opId}] Data is locked by another process (${dataWriteLockHolder}). Skipping sync run.`);
        return;
    }

    if (!await acquireLock(env.LOCKS, opId, LOCK_KEY)) {
        return; // Exit if lock is not acquired
    }

    try {
        // STAGE 1: FETCH DATA
        console.log(`[${opId}] Stage 1: Fetching all source models and current list.`);
        const { currentListStr, initialVersion } = await readCurrentData(MODELS_KV);

        const blacklist = await MODELS_KV.get("model_blacklist", "json") || [];
        const blacklistedIds = new Set(blacklist);

        const [onlineGrouped, manualGrouped] = await Promise.all([
            buildGroupedOnlineModels(env, opId, blacklistedIds),
            processManualModels(MODELS_KV, opId),
        ]);

        // STAGE 2: PROCESS AND MERGE DATA
        console.log(`[${opId}] Stage 2: Pruning, merging, and preparing final data.`);
        const freshProducers = mergeDeep(onlineGrouped, manualGrouped);
        let workingData = currentListStr ? JSON.parse(currentListStr) : { producers: {} };

        const finalProducers = rehydrateAndMergeProducers(workingData.producers, freshProducers);

        const finalData = {
            last_syncer_run: opId,
            producers: finalProducers,
            version: new Date().toISOString(), // This is temporary, will be updated on write
        };

        // STAGE 3: COMPARE AND SAVE
        console.log(`[${opId}] Stage 3: Comparing hashes and saving if changes detected.`);

        const { hex: newHex } = await hashJson(finalData, opId);
        const currentHash = await MODELS_KV.get("hash");

        if (newHex === currentHash) {
            console.log(`⚖️ [${opId}] No significant changes detected (hash match). Sync complete.`);
            return;
        }

        const currentVersionInKV = await MODELS_KV.get("version");
        if (workingData && workingData.version && currentVersionInKV !== initialVersion) {
            console.warn(`🔶 [${opId}] VERSION CONFLICT! Data was modified by another process. Aborting save.`);
            return;
        }

        console.log(`✍️ [${opId}] Changes detected. Preparing to update KV.`);
        createBackups(MODELS_KV, currentListStr, opId, context);

        finalData.version = new Date().toISOString();
        const finalJsonToWrite = JSON.stringify(finalData);

        writeNewData(MODELS_KV, finalJsonToWrite, newHex, opId, context);

    } catch (error) {
        console.error(`❌ [${opId}] CRITICAL ERROR in syncModels: ${error.message}`, error.stack);
        // In a real scenario, you might want to add alerting here (e.g., call a webhook)
    } finally {
        await releaseLock(env.LOCKS, opId, LOCK_KEY, context);
        console.log(`[${opId}] Sync process concluded.`);
    }
}