/*
 * Gateway - Response helpers
 * JSON envelopes in the dialect the caller speaks (OpenAI or Anthropic) plus CORS for the admin panel.
 */

const ALLOWED_ORIGINS = [
    'https://admin.vertexishere.com',
];

export function corsHeaders(request) {
    const origin = request.headers.get('Origin');
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
            'Access-Control-Max-Age': '86400',
        };
    }
    return {};
}

export function handleOptions(request) {
    const headers = corsHeaders(request);
    if (headers['Access-Control-Allow-Origin']) {
        return new Response(null, { status: 204, headers });
    }
    // Non-browser callers (SDKs) never preflight; browsers from other origins are refused.
    return new Response(null, { status: 204 });
}

export function jsonResponse(data, status = 200, request, extraHeaders = {}) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            ...(request ? corsHeaders(request) : {}),
            ...extraHeaders,
        },
    });
}

/**
 * Error envelope. Anthropic-style callers (/v1/messages) get Anthropic's shape, everyone else OpenAI's.
 * @param {Request} request
 * @param {number} status
 * @param {string} message
 * @param {string} code Machine-readable code, e.g. "invalid_api_key", "budget_exhausted".
 * @param {string} type OpenAI error type, e.g. "authentication_error", "billing_error".
 * @param {object} extraHeaders
 */
export function errorResponse(request, status, message, code, type = 'invalid_request_error', extraHeaders = {}) {
    const anthropic = new URL(request.url).pathname.startsWith('/v1/messages');
    const body = anthropic
        ? { type: 'error', error: { type: code, message } }
        : { error: { message, type, code } };
    return jsonResponse(body, status, request, extraHeaders);
}
