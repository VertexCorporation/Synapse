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

/**
 * Prunes producers, series, and variants from `workingProducers` that do not exist in `freshProducers`.
 * @param {ProducersData} workingProducers - The existing data from KV.
 * @param {ProducersData} freshProducers - The newly fetched data.
 * @returns {ProducersData} The pruned `workingProducers` object.
 */
function pruneStaleModels(workingProducers, freshProducers) {
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
    const pruned = pruneStaleModels(workingProducers, freshProducers);
    const finalProducers = JSON.parse(JSON.stringify(freshProducers)); // Start with a fresh copy

    for (const pName in finalProducers) {
        if (!pruned[pName]) continue;
        for (const sName in finalProducers[pName]) {
            if (sName === 'series_description') continue;
            if (!pruned[pName][sName]) continue;

            const workingSeries = pruned[pName][sName];
            const finalSeries = finalProducers[pName][sName];

            if (workingSeries.series_description) finalSeries.series_description = workingSeries.series_description;
            if (workingSeries.hidden === true) finalSeries.hidden = true;

            for (const vName in finalSeries[vName]) {
                if (!workingSeries[vName]) continue;
                const workingVariant = workingSeries[vName];
                const finalVariant = finalSeries[vName];

                // Merge description or details, preserving translations.
                if (finalVariant.source === 'manual') {
                    finalVariant.details = { ...(workingVariant.details || {}), ...(finalVariant.details || {}) };
                } else {
                    finalVariant.description = { ...(workingVariant.description || {}), ...(finalVariant.description || {}) };
                }

                // Carry over any other custom properties from the working variant.
                finalSeries[vName] = { ...workingVariant, ...finalVariant };
            }
        }
    }
    return finalProducers;
}