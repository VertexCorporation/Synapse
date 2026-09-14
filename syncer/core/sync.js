import { applyFreshFalRouting } from '../processing/fal-models.js';
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
import { buildGroupedOnlineModels } from '../processing/online.js';
import { buildGroupedFalModels } from '../processing/fal.js';
import { buildGroupedElevenLabsModels } from '../processing/elevenlabs.js';
import { buildGroupedDeepgramModels } from '../processing/deepgram.js';
import { buildGroupedCloudflareModels } from '../processing/cloudflare.js';
import { buildGroupedGroqModels } from '../processing/groq.js';
import { deduplicateProducers, attachCatalogRoutes } from '../processing/dedup.js';
import { rehydrateAndMergeProducers, applyFreshOnlineTiers, mergeCatalogRecords } from '../processing/merge.js';
import { buildGroupedHuggingFaceModels, applyFreshHuggingFaceMetadata } from '../processing/huggingface-discovery.js';
import { migrateOfflineEnrichment, mergeOfflineModels, regroupOfflineModels, offlineEntries, deduplicateOfflineModels } from '../processing/offline.js';
import { refreshHuggingFaceModels } from '../processing/huggingface.js';
import { enforceCatalogPolicy } from '../processing/catalog-policy.js';
import { hashJson, mergeDeep } from '../utils/helpers.js';
import { sortCatalog, stripCatalogRaw } from '../processing/normalize/schema.js';
import { cortexModelFromTreeEntry } from '../processing/normalize/manual.js';
import { buildMaintainedRealtimeSttRecords } from '../processing/realtime-stt.js';

const LOCK_KEY = "syncer_lock";
const DATA_WRITE_LOCK_KEY = "data_write_lock";
// KV document size guards (Cloudflare KV max is 25 MB; raw payloads are the degrade lever).
const KV_SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
const KV_HARD_LIMIT_BYTES = 24 * 1024 * 1024;

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
        const workingData = currentListStr ? JSON.parse(currentListStr) : { producers: {} };

        const blacklist = await MODELS_KV.get("model_blacklist", "json") || [];
        const blacklistedIds = new Set(blacklist);

        const [
            onlineResultSettled,
            falResultSettled,
            elevenLabsResultSettled,
            deepgramResultSettled,
            cloudflareResultSettled,
            groqResultSettled,
            manualGroupedSettled,
            huggingFaceSettled,
        ] = await Promise.allSettled([
            buildGroupedOnlineModels(env, opId, blacklistedIds),
            buildGroupedFalModels(env, opId, blacklistedIds),
            buildGroupedElevenLabsModels(env, opId, blacklistedIds),
            buildGroupedDeepgramModels(env, opId, blacklistedIds),
            buildGroupedCloudflareModels(env, opId, blacklistedIds),
            buildGroupedGroqModels(env, opId, blacklistedIds),
            processManualModels(MODELS_KV, opId),
            buildGroupedHuggingFaceModels(env, opId, blacklistedIds, workingData.producers),
        ]);

        const onlineResult = onlineResultSettled.status === "fulfilled" ? onlineResultSettled.value : { grouped: {}, fallbackGrouped: {} };
        const onlineGrouped = onlineResult?.grouped || {};
        const fallbackGrouped = onlineResult?.fallbackGrouped || {};

        // OpenRouter is the primary source: a failed or empty fetch aborts the whole
        // run (design §10.3) instead of pruning everything it owns downstream.
        if (onlineResultSettled.status === "rejected") throw onlineResultSettled.reason;

        const falGrouped = falResultSettled.status === "fulfilled" ? (falResultSettled.value?.grouped || {}) : {};
        const elevenLabsGrouped = elevenLabsResultSettled.status === "fulfilled" ? (elevenLabsResultSettled.value?.grouped || {}) : {};
        const deepgramGrouped = deepgramResultSettled.status === "fulfilled" ? (deepgramResultSettled.value?.grouped || {}) : {};
        const cloudflareGrouped = cloudflareResultSettled.status === "fulfilled" ? (cloudflareResultSettled.value?.grouped || {}) : {};
        const groqGrouped = groqResultSettled.status === "fulfilled" ? (groqResultSettled.value?.grouped || {}) : {};
        const manualGrouped = manualGroupedSettled.status === "fulfilled" ? (manualGroupedSettled.value || {}) : {};

        // Discovery handles list/repo failures itself. An unexpected rejection must not prune HF data.
        if (huggingFaceSettled.status === 'rejected') throw huggingFaceSettled.reason;
        const hfGrouped = huggingFaceSettled.value.grouped;

        // Log warnings for failed providers
        if (onlineResultSettled.status === "rejected") console.warn(`⚠️ [${opId}] OpenRouter fetch failed: ${onlineResultSettled.reason?.message}`);
        if (falResultSettled.status === "rejected") console.warn(`⚠️ [${opId}] Fal.ai fetch failed: ${falResultSettled.reason?.message}`);
        if (elevenLabsResultSettled.status === "rejected") console.warn(`⚠️ [${opId}] ElevenLabs fetch failed: ${elevenLabsResultSettled.reason?.message}`);
        if (deepgramResultSettled.status === "rejected") console.warn(`⚠️ [${opId}] Deepgram fetch failed: ${deepgramResultSettled.reason?.message}`);
        if (cloudflareResultSettled.status === "rejected") console.warn(`⚠️ [${opId}] Cloudflare fetch failed: ${cloudflareResultSettled.reason?.message}`);
        if (groqResultSettled.status === "rejected") console.warn(`⚠️ [${opId}] Groq fetch failed: ${groqResultSettled.reason?.message}`);
        if (manualGroupedSettled.status === "rejected") console.warn(`⚠️ [${opId}] Manual models fetch failed: ${manualGroupedSettled.reason?.message}`);

        // --- Catalog records + provider health (design §7 / §10) ---
        const recordsOf = settled => settled.status === "fulfilled" ? (settled.value?.records || []) : [];
        const freshCatalogRecords = [
            ...recordsOf(onlineResultSettled),
            ...recordsOf(falResultSettled),
            ...recordsOf(elevenLabsResultSettled),
            ...recordsOf(deepgramResultSettled),
            ...buildMaintainedRealtimeSttRecords(),
            ...recordsOf(cloudflareResultSettled),
            ...recordsOf(groqResultSettled),
        ];
        const healthOf = settled => settled.status === "rejected" ? false
            : (settled.value?.health ? settled.value.health.ok !== false : true);
        const providerHealth = {
            openrouter: healthOf(onlineResultSettled), // throws on failure -> rejected -> false
            fal: healthOf(falResultSettled),
            elevenlabs: healthOf(elevenLabsResultSettled),
            deepgram: healthOf(deepgramResultSettled),
            assemblyai: true,
            cloudflare: healthOf(cloudflareResultSettled),
            groq: healthOf(groqResultSettled),
            manual: healthOf(manualGroupedSettled),
            huggingface: true, // discovery handles failures internally; fatal errors throw above
        };
        // Persist health even when the run short-circuits on the hash check.
        context.waitUntil(
            MODELS_KV.put("provider_health", JSON.stringify({ at: new Date().toISOString(), providers: providerHealth }))
                .catch(e => console.warn(`⚠️ [${opId}] provider_health write failed: ${e.message}`))
        );

        // STAGE 2: PROCESS AND MERGE DATA
        console.log(`[${opId}] Stage 2: Merging all online models and deduplicating by priority...`);

        // Merge all online providers together
        let combinedOnline = {};
        combinedOnline = mergeDeep(combinedOnline, onlineGrouped);
        combinedOnline = mergeDeep(combinedOnline, falGrouped);
        combinedOnline = mergeDeep(combinedOnline, elevenLabsGrouped);
        combinedOnline = mergeDeep(combinedOnline, deepgramGrouped);
        combinedOnline = mergeDeep(combinedOnline, cloudflareGrouped);
        combinedOnline = mergeDeep(combinedOnline, groqGrouped);

        enforceCatalogPolicy(combinedOnline);
        enforceCatalogPolicy(fallbackGrouped);
        // Deduplicate across online providers: groq > cloudflare > openrouter > fal > elevenlabs > deepgram/assemblyai
        // (Manual/HuggingFace offline models are not included yet, ensuring they are NEVER touched or removed)
        const deduplicatedOnline = deduplicateProducers(combinedOnline, opId);

        // Now merge offline/manual models into the deduplicated online tree
        const freshProducers = mergeOfflineModels(deduplicatedOnline, hfGrouped, manualGrouped);
        regroupOfflineModels(freshProducers);
        enforceCatalogPolicy(workingData.producers || {});
        regroupOfflineModels(workingData.producers || {});
        enforceCatalogPolicy(workingData.fallback || {});
        migrateOfflineEnrichment(workingData.producers || {}, freshProducers);

        const finalProducers = rehydrateAndMergeProducers(workingData.producers, freshProducers);
        const finalFallbackProducers = rehydrateAndMergeProducers(workingData.fallback || {}, fallbackGrouped);
        applyFreshHuggingFaceMetadata(finalProducers, hfGrouped);
        applyFreshFalRouting(finalProducers, falGrouped);
        applyFreshOnlineTiers(finalProducers, freshProducers);
        applyFreshOnlineTiers(finalFallbackProducers, fallbackGrouped, 'fallback');

        // STAGE 2.5: LIVE HUGGING FACE REFRESH (offline/on-device GGUF models)
        // Runs last, directly on the final merged tree, so its results are the
        // ones actually written to KV (not subject to the rehydrate step above,
        // which otherwise prefers old/frozen field values for staleness safety).
        console.log(`[${opId}] Stage 2.5: Refreshing offline model metadata from HuggingFace Hub.`);
        try {
            await refreshHuggingFaceModels(finalProducers, finalFallbackProducers, env, opId);
        } catch (e) {
            console.warn(`[${opId}] HuggingFace refresh stage failed non-fatally: ${e.message}`);
        }

        enforceCatalogPolicy(finalProducers);
        deduplicateOfflineModels(finalProducers);
        enforceCatalogPolicy(finalFallbackProducers);

        // --- Catalog assembly (design §5/§7/§9) ---
        // Manual + HuggingFace records derive from the FINAL merged tree so curator
        // enrichment (tier, translations) is captured in its settled placement.
        for (const entry of offlineEntries(finalProducers)) {
            if (entry.model.source === 'manual' || entry.model.source === 'huggingface') {
                const record = cortexModelFromTreeEntry(entry);
                if (record) freshCatalogRecords.push(record);
            }
        }
        // Cross-provider routes: dedup becomes routing at the catalog level.
        attachCatalogRoutes(freshCatalogRecords);
        const oldCatalog = Array.isArray(workingData.catalog) ? workingData.catalog : [];
        const mergedCatalog = mergeCatalogRecords(freshCatalogRecords, oldCatalog, providerHealth, opId);

        const finalData = {
            last_syncer_run: opId,
            producers: finalProducers,
            fallback: finalFallbackProducers,
            // Stable ordering keeps the content hash independent of provider ordering.
            catalog: sortCatalog(mergedCatalog),
            version: new Date().toISOString(), // This is temporary, will be updated on write
        };

        // STAGE 3: COMPARE AND SAVE
        console.log(`[${opId}] Stage 3: Comparing hashes and saving if changes detected. Catalog: ${finalData.catalog.length} records.`);

        // KV size guard: degrade `raw` payloads over the soft limit; abort over the hard limit.
        let sizeGuard = JSON.stringify(finalData).length;
        if (sizeGuard > KV_SOFT_LIMIT_BYTES) {
            const stripped = stripCatalogRaw(finalData.catalog);
            console.error(`🚨 [${opId}] ALARM[kv-size]: document ${Math.round(sizeGuard / 1024)}KB exceeds the ${KV_SOFT_LIMIT_BYTES / 1024 / 1024}MB soft limit — stripped raw from ${stripped} catalog records.`);
            sizeGuard = JSON.stringify(finalData).length;
        }
        if (sizeGuard > KV_HARD_LIMIT_BYTES) {
            console.error(`🚨 [${opId}] ALARM[kv-size]: document ${Math.round(sizeGuard / 1024)}KB exceeds the hard limit even after degrade. ABORTING write.`);
            return;
        }

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
