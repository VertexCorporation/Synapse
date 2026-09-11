/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: KV Data Handler
 * Description: Handles all interactions with the MODELS_JSON KV namespace.
 * Responsible for reading, writing, and backing up the main models list.
 */

/**
 * Fetches the current 'list' and 'version' from the KV namespace.
 * @param {KVNamespace} kv - The MODELS_JSON KV namespace.
 * @returns {Promise<{currentListStr: string|null, initialVersion: string|null}>} The raw list JSON string and its version.
 */
export async function readCurrentData(kv) {
    try {
        const [currentListStr, initialVersion] = await Promise.all([
            kv.get("list"),
            kv.get("version")
        ]);
        return { currentListStr, initialVersion };
    } catch (e) {
        console.error(`❌ Failed to read current data from KV: ${e.message}`);
        return { currentListStr: null, initialVersion: null };
    }
}

/**
 * Writes the new, processed data back to the KV namespace and purges the edge cache.
 * @param {KVNamespace} kv - The MODELS_JSON KV namespace.
 * @param {string} finalJsonToWrite - The final JSON string of the model list.
 * @param {string} newHex - The MD5 hash of the new data.
 * @param {string} opId - The operation ID for logging.
 * @param {object} context - The worker execution context for `waitUntil`.
 */
export function writeNewData(kv, finalJsonToWrite, newHex, opId, context) {
    const newVersion = new Date().toISOString();

    const writePromises = [
        kv.put("list", finalJsonToWrite),
        kv.put("hash", newHex),
        kv.put("version", newVersion)
    ];

    // Purge the public edge cache ONLY after the KV writes complete. Purging
    // concurrently with the puts lets a request arriving in between re-cache
    // the OLD document for a full cache TTL (observed in production with a
    // 4h zone cache rule on cortexishere.com/models).
    context.waitUntil(
        Promise.all(writePromises)
            .then(async () => {
                console.log(`✅ [${opId}] KV updated successfully. New version: ${newVersion}`);
                const cache = caches.default;
                // The URLs must match the cache keys used in `serveModelsJson`
                // for every hostname that fronts this worker.
                const cacheKeys = [
                    new Request("https://cortexishere.com/models"),
                    new Request("https://syncer.mustawtfa.workers.dev/models"),
                ];
                await Promise.all(cacheKeys.map(key =>
                    cache.delete(key).catch(() => false)));
                console.log(`✅ [${opId}] Edge cache purge completed after KV write.`);
            })
            .catch(e => console.error(`❌ [${opId}] CRITICAL: Failed to write to KV: ${e.message}`))
    );
}

/**
 * Creates backups of the current model list before overwriting it.
 * @param {KVNamespace} kv - The MODELS_JSON KV namespace.
 * @param {string} currentListStr - The current list JSON string to back up.
 * @param {string} opId - The operation ID for logging.
 * @param {object} context - The worker execution context for `waitUntil`.
 */
export function createBackups(kv, currentListStr, opId, context) {
    if (!currentListStr) return;

    const backupJobs = async () => {
        try {
            const todayStr = new Date().toISOString().slice(0, 10);
            const dailyBackupKey = `list_backup_${todayStr}`;

            // Create immediate backup
            const immediateBackupPromise = kv.put("list_backup", currentListStr);

            // Create daily snapshot only if it doesn't exist for today
            const dailyBackupExists = await kv.get(dailyBackupKey);
            if (!dailyBackupExists) {
                console.log(`🗓️ [${opId}] Creating daily snapshot: ${dailyBackupKey}`);
                await kv.put(dailyBackupKey, currentListStr);
            }
            
            await immediateBackupPromise;
            console.log(`🗄️ [${opId}] Immediate backup to 'list_backup' is complete.`);
        } catch (e) {
            console.error(`⚠️ [${opId}] CRITICAL WARNING: Failed to create backups: ${e.message}`);
        }
    };

    context.waitUntil(backupJobs());
}