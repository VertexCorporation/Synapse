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
    
    // Check if the origin is in our allowed list
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', // Ensure PUT is included
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400', // Optional: caches preflight response for 1 day
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
            ...getCorsHeaders(request) // Apply CORS headers to all JSON responses
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
 * This is the key function to fix the error. It must return all necessary
 * Access-Control-* headers for the browser to allow the subsequent request.
 * @param {Request} request The incoming OPTIONS request.
 * @returns {Response} A Response object with only CORS headers and a 204 status.
 */
export function handleOptions(request) {
    const headers = getCorsHeaders(request);
    
    // A preflight response should not have a body and should have a 204 "No Content" status.
    // It's crucial that it returns the Allow-Methods and Allow-Headers.
    if (headers['Access-Control-Allow-Origin']) {
        return new Response(null, {
            status: 204, // No Content
            headers: headers
        });
    } else {
        // If the origin is not allowed, return a plain response.
        return new Response('Origin not allowed', { status: 403 });
    }
}