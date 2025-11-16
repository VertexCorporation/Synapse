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