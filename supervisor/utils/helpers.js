/*
 * Cortex Supervisor Worker - General Helpers
 * Contains common utility functions used across the worker.
 */

/**
 * A fetch wrapper that adds a timeout functionality.
 * @param {string|URL} url The URL to fetch.
 * @param {object} options Standard fetch options.
 * @param {number} timeoutMs The timeout in milliseconds.
 * @param {string} operationId A unique ID for logging.
 * @param {string} logIdentifier A specific identifier for logging (e.g., model ID).
 * @param {object} logger A logger instance.
 * @returns {Promise<Response>}
 * @throws {Error} Throws an error on network failure or timeout.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs, operationId, logIdentifier = "N/A", logger) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        logger.warn(`⌛ [${operationId}] Fetch to ${url} (${logIdentifier}) TIMED OUT after ${timeoutMs}ms.`);
        controller.abort('timeout');
    }, timeoutMs);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            logger.error(`⌛❌ [${operationId}] Fetch to ${url} (${logIdentifier}) ABORTED due to timeout.`);
            e.isTimeout = true;
        } else {
            logger.error(`❌ [${operationId}] Fetch to ${url} (${logIdentifier}) FAILED: ${e.name} - ${e.message}.`);
        }
        throw e;
    }
}

/**
 * Selects a random element from an array, with an optional element to exclude.
 * @param {Array<any>} arr The array to select from.
 * @param {any} [excludeElement=null] An element to exclude from selection.
 * @returns {any|undefined} The selected element or undefined if not possible.
 */
export function selectRandomElement(arr, excludeElement = null) {
    if (!arr || arr.length === 0) return undefined;
    
    let filteredArr = arr;
    if (excludeElement) {
        filteredArr = arr.filter(item => item !== excludeElement);
    }
    
    if (filteredArr.length === 0) return undefined;
    
    return filteredArr[Math.floor(Math.random() * filteredArr.length)];
}

/**
 * Creates a simple, non-cryptographic hash of a string.
 * This must be identical to the one used in the admin panel.
 * @param {string} str The string to hash.
 * @returns {string} The resulting hash string.
 */
export function simpleHash(str) {
    if (!str) return 'h0';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0; // Convert to 32bit integer
    }
    return 'h' + hash.toString(36);
}

/**
 * A fallback no-op KV object for when LOCKS_KV is not bound.
 * Prevents crashes during local development or misconfiguration.
 */
export const noopKV = {
    get: async (key) => { console.warn(`[NOOP_KV] GET "${key}". KV inactive.`); return null; },
    put: async (key, value, options) => { console.warn(`[NOOP_KV] PUT "${key}". KV inactive.`); },
    delete: async (key) => { console.warn(`[NOOP_KV] DELETE "${key}". KV inactive.`); }
};