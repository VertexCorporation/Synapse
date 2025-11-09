/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: API Utilities
 * Description: Handles all outbound network requests, incorporating features like timeouts.
 */

import { DEFAULTS } from '../config.js';

/**
 * Performs a fetch request with a specified timeout.
 * @param {string} url - The URL to fetch.
 * @param {object} [options={}] - Standard fetch options.
 * @param {number} [timeoutMs] - The timeout in milliseconds. Falls back to DEFAULTS.FETCH_TIMEOUT_MS.
 * @param {string} operationId - The operation ID for logging.
 * @returns {Promise<Response>} A promise that resolves to the Response object.
 * @throws Will throw an error if the fetch fails or times out.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs, operationId) {
    const timeoutToUse = +(timeoutMs || DEFAULTS.FETCH_TIMEOUT_MS);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.warn(`⌛ [${operationId}] Fetch to ${url} TIMED OUT after ${timeoutToUse}ms.`);
        controller.abort("timeout");
    }, timeoutToUse);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (e) {
        console.error(`❌ [${operationId}] Fetch to ${url} FAILED: ${e.name} - ${e.message}`);
        throw e; // Re-throw for the caller to handle
    } finally {
        clearTimeout(timeoutId);
    }
}