/*
 * Cortex Curator Worker - KV Storage Utilities
 * Centralizes all interactions with the Cloudflare KV namespace for manual models.
 */

const MODEL_PREFIX = "model:";

/**
 * Fetches all manual models from the KV namespace.
 * @param {KVNamespace} kv The KV namespace binding.
 * @returns {Promise<Array<Object>>} A sorted array of manual models.
 */
export async function getManualModels(kv) {
    if (!kv) {
        throw new Error("KV namespace is not provided.");
    }
    const list = await kv.list({ prefix: MODEL_PREFIX });
    if (list.keys.length === 0) {
        return [];
    }
    const promises = list.keys.map(key => kv.get(key.name, 'json'));
    const values = await Promise.all(promises);
    return values.filter(val => val).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Creates or updates a manual model in the KV namespace.
 * @param {KVNamespace} kv The KV namespace binding.
 * @param {Object} modelData The model data to save.
 * @returns {Promise<void>}
 */
export async function saveManualModel(kv, modelData) {
    if (!kv) {
        throw new Error("KV namespace is not provided.");
    }
    if (!modelData || !modelData.id || !modelData.producer || !modelData.details?.en?.title) {
        const validationError = new Error("Model data must include 'id', 'producer', and 'details.en.title'.");
        validationError.status = 400; // Custom status for the router to use
        throw validationError;
    }
    await kv.put(`${MODEL_PREFIX}${modelData.id}`, JSON.stringify(modelData));
}

/**
 * Deletes a manual model from the KV namespace.
 * @param {KVNamespace} kv The KV namespace binding.
 * @param {string} modelId The ID of the model to delete.
 * @returns {Promise<void>}
 */
export async function deleteManualModel(kv, modelId) {
    if (!kv) {
        throw new Error("KV namespace is not provided.");
    }
    if (!modelId) {
        const validationError = new Error("Model ID is required for deletion.");
        validationError.status = 400;
        throw validationError;
    }
    await kv.delete(`${MODEL_PREFIX}${modelId}`);
}