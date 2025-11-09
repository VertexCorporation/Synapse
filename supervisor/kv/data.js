/*
 * Cortex Supervisor Worker - KV Data Manager
 * Handles reading and writing the main 'list.json' data object from/to KV.
 */

/**
 * Reads the latest models list and its version from the KV namespace.
 * @param {KVNamespace} kv The MODELS_JSON KV namespace.
 * @returns {Promise<{data: Object|null, version: string|null}>} The parsed data and version string.
 */
export async function readModelsData(kv) {
    const [listStr, version] = await Promise.all([
        kv.get('list'),
        kv.get('version')
    ]);

    if (!listStr) {
        return { data: null, version: null };
    }

    try {
        const data = JSON.parse(listStr);
        return { data, version };
    } catch (e) {
        throw new Error(`Failed to parse 'list.json' from KV: ${e.message}`);
    }
}

/**
 * Writes the updated models list and a new version to the KV namespace.
 * @param {KVNamespace} kv The MODELS_JSON KV namespace.
 * @param {Object} data The complete models data object to write.
 * @param {string} opId The operation ID to stamp on the data.
 * @returns {Promise<string>} The new version string.
 */
export async function writeModelsData(kv, data, opId) {
    const newVersion = new Date().toISOString();
    
    // Stamp the data with metadata about this run
    data.last_supervisor_run = opId;
    data.last_supervisor_update_ts = newVersion;
    
    await Promise.all([
        kv.put('list', JSON.stringify(data)),
        kv.put('version', newVersion)
    ]);
    
    return newVersion;
}