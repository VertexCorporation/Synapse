/*
 * Gateway - Upstream (Cloudflare Workers AI) plumbing
 * Workers AI exposes OpenAI-compatible chat/completions and embeddings endpoints under
 * https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1. This module decides which
 * /v1 paths are proxied and rewrites the incoming request for that endpoint.
 */

// path -> allowed methods. Everything else is refused before touching the budget.
export const PROXIED_ROUTES = {
    '/v1/chat/completions': ['POST'],
    '/v1/embeddings': ['POST'],
    '/v1/models': ['GET'],   // served from the price catalog, never forwarded
};

// Request headers that are forwarded upstream as-is.
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept'];

// Response headers dropped before the client sees them (hop-by-hop or misleading behind a proxy).
const DROPPED_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie', 'cf-ray', 'cf-cache-status', 'alt-svc', 'server']);

export function apiBase(env) {
    return (env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
}

export function parseAllowlist(raw) {
    return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function parseAliases(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        console.error('[GATEWAY] MODEL_ALIASES is not valid JSON; ignoring.');
        return {};
    }
}

/**
 * Applies aliases and the allowlist to a model id.
 * @returns {{model: string|undefined, allowed: boolean}}
 */
export function resolveModel(model, allowlist, aliases) {
    if (typeof model !== 'string' || !model) return { model, allowed: true };
    const resolved = aliases[model] || model;
    if (!allowlist.length) return { model: resolved, allowed: true };
    const allowed = allowlist.some(entry => entry.endsWith('/') ? resolved.startsWith(entry) : resolved === entry);
    return { model: resolved, allowed };
}

/**
 * Text a request will be billed for on the input side, used only to estimate tokens when the
 * upstream response carries no usage block. Covers chat `messages` and embeddings `input`.
 */
export function promptText(body) {
    if (!body || typeof body !== 'object') return '';
    if (Array.isArray(body.messages)) {
        return body.messages.map(m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')).join('\n');
    }
    if (typeof body.input === 'string') return body.input;
    if (Array.isArray(body.input)) return body.input.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
    if (typeof body.prompt === 'string') return body.prompt;
    return '';
}

/**
 * Builds the upstream fetch for a proxied request.
 * @param {Request} request Incoming request.
 * @param {string} path Normalised path (one of PROXIED_ROUTES).
 * @param {object} env Worker env.
 * @param {object} opts { allowlist, aliases }
 * @returns {Promise<{request: Request, model: string|null, stream: boolean, promptChars: number}|{error: string, status: number, code: string}>}
 */
export async function buildUpstreamRequest(request, path, env, { allowlist, aliases }) {
    const url = new URL(request.url);
    const target = `${apiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/ai${path}${url.search}`;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    headers.set('Authorization', `Bearer ${env.CF_API_TOKEN}`);

    const raw = await request.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Body must be a JSON object.', status: 400, code: 'invalid_body' };
    }

    const resolved = resolveModel(parsed.model, allowlist, aliases);
    if (typeof resolved.model !== 'string' || !resolved.model) {
        return { error: 'A "model" is required.', status: 400, code: 'model_required' };
    }
    if (!resolved.allowed) {
        return { error: `Model '${parsed.model}' is not available through this gateway.`, status: 403, code: 'model_not_allowed' };
    }
    parsed.model = resolved.model;
    headers.set('content-type', 'application/json');

    return {
        request: new Request(target, { method: 'POST', headers, body: JSON.stringify(parsed) }),
        model: resolved.model,
        stream: parsed.stream === true,
        promptChars: promptText(parsed).length,
    };
}

/**
 * Copies upstream response headers for the client, minus hop-by-hop noise.
 */
export function clientResponseHeaders(upstream, extra = {}) {
    const headers = new Headers();
    upstream.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
}
