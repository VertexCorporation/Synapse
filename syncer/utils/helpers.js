/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Utility Helpers
 * Description: A collection of generic, reusable helper functions.
 * These functions are context-agnostic and can be used across different modules.
 */

/**
 * A fallback no-op KV object for when the LOCKS KV namespace is not bound.
 * Prevents runtime errors during local development or in certain environments.
 */
export const noopKV = {
    get: async () => null,
    put: async (key) => console.warn(`[noopKV] PUT on "${key}". Lock inactive.`),
    delete: async (key) => console.warn(`[noopKV] DELETE on "${key}". Lock inactive.`),
};

/**
 * Removes the provider prefix from a model variant name if it exists.
 * e.g., "openai: gpt-4" -> "gpt-4"
 * @param {string} s The input string.
 * @returns {string} The processed string.
 */
export const stripLeftOfColonForVariant = (s) => s.includes(":") ? s.split(":").slice(1).join(":").trim() : s.trim();

/**
 * Cleans a model name by removing common parenthetical metadata.
 * e.g., "Llama 3 (Instruct)" -> "Llama 3"
 * @param {string} n The model name string.
 * @returns {string} The cleaned name.
 */
export const cleanNameForVariant = (n) =>
    n
    .replace(
        /\s*\((?:free|thinking|preview|beta|alpha|instruct|chat|v\d+\.\d+|series|v\d{4}|-\d{4}).*?\)/gi,
        "",
    )
    .trim();

/**
 * Checks if a model's pricing exceeds the defined limits.
 * @param {object} pricing - The pricing object from the API.
 * @param {number} textLimit - The maximum allowed cost for text-based pricing.
 * @param {number} imageLimit - The maximum allowed cost for image-based pricing.
 * @param {number} webSearchLimit - The maximum allowed cost for web search or per-request pricing.
 * @returns {boolean} True if the model is too expensive, false otherwise.
 */
export function isTooExpensive(pricing, textLimit, imageLimit, webSearchLimit) {
    if (!pricing || typeof pricing !== "object") return false;

    for (const [key, val] of Object.entries(pricing)) {
        const cost = Number(val) || 0;
        const lowerKey = key.toLowerCase();

        if (lowerKey.includes("image")) {
            if (cost > imageLimit) return true;
        } else if (lowerKey.includes("web_search") || lowerKey.includes("request")) {
            if (cost > webSearchLimit) return true;
        } else {
            // This covers "prompt", "completion", "input_cache_read", etc.
            if (cost > textLimit) return true;
        }
    }
    return false;
}

/**
 * Generates a SHA-256 hash of a JSON object for change detection.
 * @param {object} obj - The JSON object to hash.
 * @param {string} operationId - The operation ID for logging potential errors.
 * @returns {Promise<{json: string, hex: string}>} A promise that resolves to the JSON string and its hex hash.
 */
export async function hashJson(obj, operationId) {
  try {
    const jsonString = JSON.stringify(obj);
    const data = new TextEncoder().encode(jsonString);

    const hashBuffer = await crypto.subtle.digest("SHA-256", data);

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return { json: jsonString, hex };
  } catch (e) {
    console.error(`❌ [${operationId}] Hashing failed: ${e.message}`);
    throw e; // Re-throw to be handled by the caller
  }
}

/**
 * Deeply merges two objects, combining their properties. `source` properties overwrite `target` properties.
 * This version includes protection against Prototype Pollution.
 * @param {object} target - The object to merge into.
 * @param {object} source - The object to merge from.
 * @returns {object} The new, merged object.
 */
export function mergeDeep(target, source) {
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                return;
            }
            if (isObject(source[key]) && key in target && isObject(target[key])) {
                output[key] = mergeDeep(target[key], source[key]);
            } else {
                output[key] = source[key];
            }
        });
    }
    return output;
}

/**
 * Helper function to check if a variable is a non-null object.
 * @param {*} item The variable to check.
 * @returns {boolean}
 */
function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}