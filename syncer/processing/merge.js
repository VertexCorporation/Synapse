/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Data Merger
 * Description: Intelligently merges fresh data into existing data structures.
 * Handles pruning of stale models and rehydrating existing ones with new info
 * while preserving enriched data like translations.
 */

/**
 * @typedef {import('../types.js').ProducersData} ProducersData
 */

import { mergeDeep } from '../utils/helpers.js';

/**
 * Prunes producers, series, and variants from `workingProducers` that do not exist in `freshProducers`.
 * @param {ProducersData} workingProducers - The existing data from KV.
 * @param {ProducersData} freshProducers - The newly fetched data.
 * @returns {ProducersData} The pruned `workingProducers` object.
 */
function pruneStaleModels(workingProducers, freshProducers) {
    if (!workingProducers || typeof workingProducers !== 'object') return {};
    let prunedItems = 0;
    for (const pName in workingProducers) {
        if (!freshProducers[pName]) {
            delete workingProducers[pName];
            prunedItems++;
            continue;
        }
        for (const sName in workingProducers[pName]) {
            if (sName === 'series_description') continue;
            if (!freshProducers[pName][sName]) {
                delete workingProducers[pName][sName];
                prunedItems++;
                continue;
            }
            for (const vName in workingProducers[pName][sName]) {
                if (vName === 'series_description' || vName === 'hidden') continue;
                if (!freshProducers[pName][sName][vName]) {
                    delete workingProducers[pName][sName][vName];
                    prunedItems++;
                }
            }
            if (Object.keys(workingProducers[pName][sName]).filter(k => k !== 'series_description' && k !== 'hidden').length === 0) {
                delete workingProducers[pName][sName];
                prunedItems++;
            }
        }
        if (Object.keys(workingProducers[pName]).length === 0) {
            delete workingProducers[pName];
            prunedItems++;
        }
    }
    if (prunedItems > 0) console.log(`[dataMerger] Pruning complete. Removed ${prunedItems} stale entries.`);
    return workingProducers;
}

/**
 * Intelligently merges fresh data into the pruned working data, preserving enriched content.
 * @param {ProducersData} workingProducers - The existing, pruned data from KV.
 * @param {ProducersData} freshProducers - The newly fetched data.
 * @returns {ProducersData} The fully merged and rehydrated producers object.
 */
export function rehydrateAndMergeProducers(workingProducers, freshProducers) {
    // First, prune models from the old data that no longer exist in the fresh data.
    const prunedWorkingProducers = pruneStaleModels(workingProducers, freshProducers);

    // Then, deep merge the pruned old data INTO the new data.
    // This ensures that fresh core data from the API is present, but any existing enriched data
    // (like translations, statuses, or manual edits from the Curator) from the old data is preserved.
    // The `mergeDeep` function will let properties from the second argument (prunedWorkingProducers)
    // overwrite properties in the first (freshProducers), preserving manual changes.
    return mergeDeep(freshProducers, prunedWorkingProducers);
}
// Pricing tiers are source-owned. Old KV enrichment must not revive retired premium tiers.
export function applyFreshOnlineTiers(finalProducers, freshProducers, defaultTier = 'standard') {
    const tiers = new Map();
    for (const producer of Object.values(freshProducers || {})) {
        for (const series of Object.values(producer || {})) {
            for (const model of Object.values(series || {})) {
                if (model?.id && ['standard', 'fallback'].includes(model.tier)) tiers.set(`${model.source}:${model.id}`, model.tier);
            }
        }
    }
    for (const producer of Object.values(finalProducers || {})) {
        for (const series of Object.values(producer || {})) {
            for (const model of Object.values(series || {})) {
                if (!model?.id) continue;
                const tier = tiers.get(`${model.source}:${model.id}`)
                    || (model.tier === 'premium' && ['openrouter', 'fal', 'cloudflare', 'groq', 'elevenlabs', 'deepgram', 'assemblyai'].includes(model.source) ? defaultTier : null);
                if (tier) model.tier = tier;
            }
        }
    }
}

// ---------------------------------------------------------------------------------
// Catalog record merge (design §7): fresh provider facts win; curator enrichment
// survives; bookkeeping (firstSeenAt / lastSeenAt / absentStreak) never churns the
// hash. A provider that failed this run (providerHealth[source] === false) must
// NOT prune its records — they stay as last known good state.
// ---------------------------------------------------------------------------------

const ABSENT_STREAK_PRUNE_THRESHOLD = 3;
const BOOKKEEPING_KEYS = new Set(['firstSeenAt', 'lastSeenAt', 'absentStreak', 'routes']);
/** Sources rebuilt from KV / Hub every run: a missing record means a real deletion. */
const IMMEDIATE_PRUNE_SOURCES = new Set(['manual', 'huggingface']);

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

/** Content fingerprint excluding bookkeeping + recomputed routes. */
function catalogContentKey(record) {
    const content = {};
    for (const [key, value] of Object.entries(record || {})) {
        if (BOOKKEEPING_KEYS.has(key)) continue;
        content[key] = value;
    }
    return JSON.stringify(content);
}

/** Curator enrichment that must survive fresh provider facts. */
function mergeCatalogEnrichment(fresh, old) {
    if (old.tier === 'premium' && fresh.tier !== 'premium') fresh.tier = 'premium';
    const oldAliases = old.identity?.aliases;
    if (Array.isArray(oldAliases) && oldAliases.length) {
        fresh.identity = fresh.identity || {};
        fresh.identity.aliases = [...new Set([...(fresh.identity.aliases || []), ...oldAliases])];
    }
    for (const key of ['curator', 'processingStatus']) {
        if (old[key] !== undefined) fresh[key] = old[key];
    }
}

/**
 * Merges fresh catalog records into the previous catalog.
 * @param {object[]} freshRecords - This run's normalized CortexModels (routes attached).
 * @param {object[]} oldCatalog - The catalog array from the previous KV list document.
 * @param {Object<string, {ok: boolean}>} providerHealth - Per-source health for this run.
 * @param {string} operationId
 * @returns {object[]} The merged catalog records (unsorted).
 */
export function mergeCatalogRecords(freshRecords, oldCatalog, providerHealth, operationId) {
    const opId = `${operationId}-catalog`;
    const oldByKey = new Map(
        (Array.isArray(oldCatalog) ? oldCatalog : []).filter(r => r?.id && r?.source)
            .map(r => [`${r.source}:${r.id}`, r]));
    const freshKeys = new Set();
    const merged = [];
    let updated = 0, newRecords = 0, grace = 0, pruned = 0, preserved = 0;

    for (const fresh of freshRecords) {
        if (!fresh?.id || !fresh?.source) continue;
        const key = `${fresh.source}:${fresh.id}`;
        if (freshKeys.has(key)) continue; // duplicate raw entries (e.g. Deepgram versions)
        freshKeys.add(key);
        const old = oldByKey.get(key);
        if (!old) {
            fresh.firstSeenAt = todayISO();
            fresh.lastSeenAt = fresh.firstSeenAt;
            fresh.absentStreak = 0;
            merged.push(fresh);
            newRecords++;
            continue;
        }
        mergeCatalogEnrichment(fresh, old);
        fresh.firstSeenAt = old.firstSeenAt || todayISO();
        fresh.absentStreak = 0;
        fresh.lastSeenAt = catalogContentKey(fresh) === catalogContentKey(old)
            ? (old.lastSeenAt || todayISO()) // content-gated: no churn when nothing changed
            : todayISO();
        merged.push(fresh);
        if (fresh.lastSeenAt !== old.lastSeenAt) updated++;
    }

    for (const [key, old] of oldByKey) {
        if (freshKeys.has(key)) continue;
        const healthy = providerHealth ? providerHealth[old.source] !== false : true;
        if (!healthy) {
            // Provider failed this run: keep last known good state untouched.
            merged.push(old);
            preserved++;
            continue;
        }
        if (IMMEDIATE_PRUNE_SOURCES.has(old.source)) {
            // Manual / HF records are rebuilt from KV / Hub every run; absence is deletion.
            pruned++;
            continue;
        }
        const streak = (old.absentStreak || 0) + 1;
        if (streak >= ABSENT_STREAK_PRUNE_THRESHOLD) {
            console.log(`✂️ [${opId}] Pruning [${old.source}] "${old.id}" after ${streak} consecutive healthy absences.`);
            pruned++;
            continue;
        }
        old.absentStreak = streak;
        merged.push(old);
        grace++;
    }

    console.log(`📦 [${opId}] Catalog merge: ${merged.length} records (${newRecords} new, ${updated} updated, ${grace} in absence grace, ${pruned} pruned, ${preserved} kept from unhealthy providers).`);
    return merged;
}
