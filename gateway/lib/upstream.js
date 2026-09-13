/*
 * Gateway - Upstream (OpenRouter) plumbing
 * Which /v1 paths are proxied, how the request is rewritten, and the generation-stats fallback
 * used when a response carries no `usage.cost`.
 */

// path -> allowed methods. Everything else is refused before touching the budget.
export const PROXIED_ROUTES = {
    '/v1/chat/completions': ['POST'],
    '/v1/completions': ['POST'],
    '/v1/messages': ['POST'],
    '/v1/responses': ['POST'],
    '/v1/embeddings': ['POST'],
    '/v1/models': ['GET'],
};

// Only GETs that cannot spend money skip the budget check.
export const FREE_ROUTES = new Set(['/v1/models']);

// Request headers that are forwarded upstream as-is.
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'x-stainless-lang'];

// Response headers dropped before the client sees them (hop-by-hop or misleading behind a proxy).
const DROPPED_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie', 'cf-ray', 'cf-cache-status', 'alt-svc', 'server']);

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
 * Builds the upstream fetch for a proxied request.
 * @param {Request} request Incoming request.
 * @param {string} path Normalised path (one of PROXIED_ROUTES).
 * @param {object} env Worker env.
 * @param {object} opts { allowlist, aliases }
 * @returns {Promise<{request: Request, model: string|null, stream: boolean}|{error: string, status: number, code: string}>}
 */
export async function buildUpstreamRequest(request, path, env, { allowlist, aliases }) {
    const base = (env.OPENROUTER_BASE || 'https://openrouter.ai').replace(/\/+$/, '');
    const url = new URL(request.url);
    const target = `${base}/api${path}${url.search}`;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    headers.set('Authorization', `Bearer ${env.OPENROUTER_KEY}`);
    if (env.OPENROUTER_REFERER) headers.set('HTTP-Referer', env.OPENROUTER_REFERER);
    if (env.OPENROUTER_TITLE) headers.set('X-Title', env.OPENROUTER_TITLE);

    let body = null;
    let model = null;
    let stream = false;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        const raw = await request.text();
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const resolved = resolveModel(parsed.model, allowlist, aliases);
            if (!resolved.allowed) {
                return { error: `Model '${parsed.model}' is not available through this gateway.`, status: 403, code: 'model_not_allowed' };
            }
            if (resolved.model !== undefined) parsed.model = resolved.model;
            model = typeof parsed.model === 'string' ? parsed.model : null;
            stream = parsed.stream === true;
            body = JSON.stringify(parsed);
            headers.set('content-type', 'application/json');
        } else {
            body = raw; // Not JSON we understand; forward untouched.
        }
    }

    return {
        request: new Request(target, { method: request.method, headers, body }),
        model,
        stream,
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

/**
 * Fallback: asks OpenRouter for the final cost of a generation. Stats can lag the response by a
 * moment, so this retries a few times before giving up.
 * @returns {Promise<number|null>} cost in USD, or null when unavailable.
 */
export async function lookupGenerationCost(id, env, { attempts = 4, delayMs = 1500 } = {}) {
    const base = (env.OPENROUTER_BASE || 'https://openrouter.ai').replace(/\/+$/, '');
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(`${base}/api/v1/generation?id=${encodeURIComponent(id)}`, {
                headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}` },
            });
            if (res.ok) {
                const data = await res.json();
                const cost = data && data.data && typeof data.data.total_cost === 'number' ? data.data.total_cost : null;
                if (cost != null) return cost;
            } else if (res.status !== 404) {
                console.warn(`[GATEWAY] generation lookup for ${id} returned ${res.status}`);
            }
        } catch (e) {
            console.warn(`[GATEWAY] generation lookup for ${id} failed: ${e.message}`);
        }
        if (attempt < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
}
