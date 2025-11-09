/*
 * Cortex Curator Worker - Response Utilities
 * Manages standardized JSON responses and CORS headers.
 */

const ALLOWED_ORIGINS = [
    'https://admin.vertexishere.com',
];

/**
 * Generates appropriate CORS headers based on the request origin.
 * @param {Request} request The incoming request.
 * @returns {HeadersInit} An object containing CORS headers.
 */
function getCorsHeaders(request) {
    const origin = request.headers.get('Origin');
    if (ALLOWED_ORIGINS.includes(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };
    }
    // No origin match, return empty object.
    return {};
}

/**
 * Creates a standard JSON response.
 * @param {any} data The data to be stringified.
 * @param {number} status The HTTP status code.
 * @param {Request} request The original request for CORS headers.
 * @returns {Response} A Response object.
 */
export function jsonResponse(data, status = 200, request) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            ...getCorsHeaders(request)
        }
    });
}

/**
 * Creates a standard error JSON response.
 * @param {string} message The error message.
 * @param {number} status The HTTP status code.
 * @param {Request} request The original request for CORS headers.
 * @returns {Response} A Response object.
 */
export function errorResponse(message, status = 400, request) {
    return jsonResponse({ error: message }, status, request);
}

/**
 * Handles CORS preflight (OPTIONS) requests.
 * @param {Request} request The incoming OPTIONS request.
 * @returns {Response} A Response object with CORS headers.
 */
export function handleOptions(request) {
    return new Response(null, {
        headers: getCorsHeaders(request)
    });
}