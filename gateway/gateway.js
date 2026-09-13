/*
 * Vertex Gateway Worker - v1.0
 * A metered proxy in front of Cloudflare Workers AI for the Array department.
 *
 * The company's Cloudflare credentials (CF_ACCOUNT_ID + CF_API_TOKEN) stay inside the worker.
 * Every member gets a personal gateway key (`vxg_...`); the worker forwards their requests to
 * Workers AI's OpenAI-compatible endpoints, prices each response from the token counts and the
 * model's published per-million-token price, and stops forwarding once the member's
 * calendar-month spend reaches their budget (MONTHLY_LIMIT_USD, overridable per member).
 * Budgets reset on the 1st of the month in QUOTA_TIMEZONE.
 *
 * Routes
 *   GET  /                      service info
 *   GET  /health                liveness
 *   GET  /v1/me                 caller's budget for the current month
 *   POST /v1/chat/completions   proxied to Workers AI and metered
 *   POST /v1/embeddings         proxied to Workers AI and metered
 *   GET  /v1/models             priced models the gateway can serve (free)
 *   POST   /admin/members            create a member or rotate their key   { email, limitUsd? }
 *   GET    /admin/members            list members with current-month spend (?month=YYYY-MM)
 *   GET    /admin/members/:email     one member with full history
 *   PATCH  /admin/members/:email     { active?, limitUsd? }
 *   DELETE /admin/members/:email     revoke (deactivate) a member
 *   GET    /admin/catalog            price catalog status (?refresh=1 re-fetches it)
 */

import { Registry } from './durable/registry.js';
import { Ledger } from './durable/ledger.js';
import { verifyAdmin } from './lib/auth.js';
import { generateKey, hashKey, extractCredential, normalizeEmail, KEY_PREFIX } from './lib/keys.js';
import { monthKey, monthResetAt, parseUsd, roundUsd } from './lib/quota.js';
import { jsonResponse, errorResponse, handleOptions } from './lib/response.js';
import { extractUsage, mergeUsage, emptyUsage, meterStream } from './lib/sse.js';
import { PROXIED_ROUTES, buildUpstreamRequest, clientResponseHeaders, parseAllowlist, parseAliases, resolveModel } from './lib/upstream.js';
import { fetchCatalog, priceFor, costFor, costFromNeurons, estimateTokensFromChars, parsePriceOverrides, listPricedModels } from './lib/pricing.js';

export { Registry, Ledger };

const VERSION = '1.0.0';
const DEFAULT_LIMIT_USD = 25;
const MEMBER_CACHE_TTL_MS = 30 * 1000;            // revocations take effect within this window
const CATALOG_MEMORY_TTL_MS = 10 * 60 * 1000;     // per-isolate cache of the price catalog
const CATALOG_STALE_MS = 6 * 60 * 60 * 1000;      // re-fetch the catalog from Cloudflare after this

// key hash -> { member, expiresAt } (per isolate)
const memberCache = new Map();
// { entries, fetchedAt, checkedAt } (per isolate)
let catalogCache = null;

function registryStub(env) {
    return env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
}

function ledgerStub(env, email) {
    return env.LEDGER.get(env.LEDGER.idFromName(email));
}

function settings(env) {
    return {
        timeZone: env.QUOTA_TIMEZONE || 'Europe/Istanbul',
        defaultLimitUsd: parseUsd(env.MONTHLY_LIMIT_USD, DEFAULT_LIMIT_USD),
        allowlist: parseAllowlist(env.MODEL_ALLOWLIST),
        aliases: parseAliases(env.MODEL_ALIASES),
        priceOverrides: parsePriceOverrides(env.MODEL_PRICES),
    };
}

function limitFor(member, cfg) {
    return typeof member.limitUsd === 'number' ? member.limitUsd : cfg.defaultLimitUsd;
}

// --- Price catalog -----------------------------------------------------------------------------

/**
 * Returns the cached Workers AI catalog, refreshing it from Cloudflare when stale. Falls back to
 * whatever was last stored (or null, which leaves only the built-in price table) if the API fails.
 */
async function loadCatalog(env, { force = false } = {}) {
    const now = Date.now();
    if (!force && catalogCache && now - catalogCache.checkedAt < CATALOG_MEMORY_TTL_MS) return catalogCache;

    const registry = registryStub(env);
    let stored = await registry.getCatalog();
    if (force || !stored || now - stored.fetchedAt > CATALOG_STALE_MS) {
        try {
            const entries = await fetchCatalog(env);
            stored = await registry.setCatalog(entries);
            console.log(`[GATEWAY] price catalog refreshed: ${entries.length} priced models`);
        } catch (e) {
            console.error(`[GATEWAY] price catalog refresh failed: ${e.message}${stored ? ' (serving stored copy)' : ' (built-in prices only)'}`);
        }
    }
    catalogCache = { entries: stored ? stored.entries : null, fetchedAt: stored ? stored.fetchedAt : null, checkedAt: now };
    return catalogCache;
}

// --- Member authentication ---------------------------------------------------------------------

async function authenticateMember(request, env) {
    const credential = extractCredential(request);
    if (!credential) return { error: errorResponse(request, 401, 'Missing API key.', 'missing_api_key', 'authentication_error') };
    if (!credential.startsWith(KEY_PREFIX)) return { error: errorResponse(request, 401, 'Invalid API key.', 'invalid_api_key', 'authentication_error') };

    const keyHash = await hashKey(credential);
    const now = Date.now();
    const cached = memberCache.get(keyHash);
    let member = cached && cached.expiresAt > now ? cached.member : null;

    if (!member) {
        member = await registryStub(env).lookup(keyHash);
        if (!member) return { error: errorResponse(request, 401, 'Invalid API key.', 'invalid_api_key', 'authentication_error') };
        memberCache.set(keyHash, { member, expiresAt: now + MEMBER_CACHE_TTL_MS });
    }
    if (!member.active) return { error: errorResponse(request, 403, 'This API key has been revoked.', 'key_revoked', 'authentication_error') };
    return { member };
}

// --- Metering ----------------------------------------------------------------------------------

/**
 * Prices a finished request and records it. Workers AI's own `neurons` figure wins when present
 * (it is exactly what Cloudflare bills); otherwise tokens x the model's list price, and when the
 * body carried no usage block at all the token counts are estimated from character counts
 * (generously), never skipped.
 */
async function settleUsage(env, email, month, summary, model, price, promptChars) {
    let promptTokens = summary.promptTokens;
    let completionTokens = summary.completionTokens;
    let estimated = false;
    if (promptTokens == null) { promptTokens = estimateTokensFromChars(promptChars); estimated = true; }
    if (completionTokens == null) { completionTokens = estimateTokensFromChars(summary.chars); estimated = true; }
    const byNeurons = summary.neurons != null;
    if (byNeurons) estimated = false;
    const cost = byNeurons ? costFromNeurons(summary.neurons) : costFor(price, promptTokens, completionTokens);
    const usage = await ledgerStub(env, email).settle({ month, costUsd: cost, promptTokens, completionTokens, model, estimated });
    console.log(`[GATEWAY] ${email} ${model} tokens=${promptTokens}+${completionTokens}${byNeurons ? ` neurons=${summary.neurons}` : ''}${estimated ? ' (estimated)' : ''} cost=${cost.toFixed(6)} month=${month} spent=${usage.spentUsd.toFixed(4)}`);
}

function quotaHeaders(quota, month, cfg) {
    return {
        'X-Gateway-Budget-Limit-Usd': String(quota.limitUsd),
        'X-Gateway-Budget-Spent-Usd': String(roundUsd(quota.spentUsd)),
        'X-Gateway-Budget-Resets-At': monthResetAt(month, cfg.timeZone).toISOString(),
    };
}

async function handleProxy(request, path, env, ctx, member) {
    const cfg = settings(env);
    const month = monthKey(new Date(), cfg.timeZone);
    const limitUsd = limitFor(member, cfg);

    const quota = await ledgerStub(env, member.email).authorize({ month, limitUsd });
    if (!quota.ok) {
        return errorResponse(
            request, 402,
            `Monthly budget exhausted: $${quota.spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} used. Resets ${monthResetAt(month, cfg.timeZone).toISOString()}.`,
            'budget_exhausted', 'billing_error', quotaHeaders(quota, month, cfg),
        );
    }

    const built = await buildUpstreamRequest(request, path, env, cfg);
    if (built.error) {
        return errorResponse(request, built.status, built.error, built.code, 'invalid_request_error');
    }

    const catalog = await loadCatalog(env);
    const price = priceFor(built.model, catalog.entries, cfg.priceOverrides);
    if (!price) {
        return errorResponse(request, 403, `Model '${built.model}' has no known price on Workers AI, so it cannot be metered. See GET /v1/models for the models this gateway serves.`, 'model_not_priced', 'invalid_request_error');
    }

    let upstream;
    try {
        upstream = await fetch(built.request);
    } catch (e) {
        console.error(`[GATEWAY] upstream fetch failed: ${e.message}`);
        return errorResponse(request, 502, 'Workers AI is unreachable.', 'upstream_unreachable', 'api_error');
    }

    const headers = clientResponseHeaders(upstream, quotaHeaders(quota, month, cfg));

    // Errors cost nothing: pass them straight through.
    if (!upstream.ok || !upstream.body) {
        return new Response(upstream.body, { status: upstream.status, headers });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
        const { clientBody, summary } = meterStream(upstream.body);
        ctx.waitUntil(summary.then(s => settleUsage(env, member.email, month, s, built.model, price, built.promptChars)));
        return new Response(clientBody, { status: upstream.status, headers });
    }

    const text = await upstream.text();
    let summary = emptyUsage();
    try { summary = mergeUsage(summary, extractUsage(JSON.parse(text))); } catch { /* non-JSON success body; estimated below */ }
    ctx.waitUntil(settleUsage(env, member.email, month, summary, built.model, price, built.promptChars));
    return new Response(text, { status: upstream.status, headers });
}

async function handleModels(request, env) {
    const cfg = settings(env);
    const catalog = await loadCatalog(env);
    const models = listPricedModels(catalog.entries, cfg.priceOverrides)
        .filter(m => resolveModel(m.id, cfg.allowlist, {}).allowed)
        .map(m => ({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: 'cloudflare',
            kind: m.kind,
            context_window: m.contextWindow,
            pricing: { currency: 'USD', input_per_million: m.inputPerM, output_per_million: m.outputPerM, source: m.source },
        }));
    return jsonResponse({ object: 'list', data: models }, 200, request);
}

async function handleMe(request, env, member) {
    const cfg = settings(env);
    const month = monthKey(new Date(), cfg.timeZone);
    const limitUsd = limitFor(member, cfg);
    const usage = await ledgerStub(env, member.email).status({ month });
    return jsonResponse({
        email: member.email,
        month,
        limitUsd,
        spentUsd: usage.spentUsd,
        remainingUsd: roundUsd(Math.max(0, limitUsd - usage.spentUsd)),
        requests: usage.requests,
        unpricedRequests: usage.unpricedRequests,
        estimatedRequests: usage.estimatedRequests || 0,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        byModel: usage.byModel,
        resetsAt: monthResetAt(month, cfg.timeZone).toISOString(),
    }, 200, request);
}

// --- Admin -------------------------------------------------------------------------------------

function parseLimit(value) {
    if (value === undefined) return { present: false };
    if (value === null) return { present: true, value: null };
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n) || n < 0) return { present: true, invalid: true };
    return { present: true, value: n };
}

async function memberView(env, record, month, cfg) {
    const usage = await ledgerStub(env, record.email).status({ month });
    const limitUsd = limitFor(record, cfg);
    const { keyHash, ...safe } = record;
    return {
        ...safe,
        limitUsd,
        customLimit: typeof record.limitUsd === 'number',
        month,
        spentUsd: usage.spentUsd,
        remainingUsd: roundUsd(Math.max(0, limitUsd - usage.spentUsd)),
        requests: usage.requests,
        unpricedRequests: usage.unpricedRequests,
        estimatedRequests: usage.estimatedRequests || 0,
        lastAt: usage.lastAt,
    };
}

async function handleAdmin(request, path, env) {
    const auth = await verifyAdmin(request, env);
    if (!auth.ok) return jsonResponse({ error: auth.error }, 401, request);

    const cfg = settings(env);
    const url = new URL(request.url);
    const registry = registryStub(env);
    const segments = path.split('/').filter(Boolean); // ['admin', 'members'|'catalog', ':email'?]

    // GET /admin/catalog
    if (segments[1] === 'catalog' && !segments[2] && request.method === 'GET') {
        const catalog = await loadCatalog(env, { force: url.searchParams.get('refresh') === '1' });
        const models = listPricedModels(catalog.entries, cfg.priceOverrides);
        return jsonResponse({
            fetchedAt: catalog.fetchedAt ? new Date(catalog.fetchedAt).toISOString() : null,
            liveModels: catalog.entries ? catalog.entries.length : 0,
            pricedModels: models.length,
            sources: models.reduce((acc, m) => ({ ...acc, [m.source]: (acc[m.source] || 0) + 1 }), {}),
        }, 200, request);
    }

    if (segments[1] !== 'members') return jsonResponse({ error: 'Not found.' }, 404, request);
    const targetEmail = segments[2] ? normalizeEmail(decodeURIComponent(segments[2])) : null;

    // POST /admin/members
    if (!segments[2] && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Body must be JSON.' }, 400, request); }
        const email = normalizeEmail(body.email);
        if (!email) return jsonResponse({ error: 'A valid "email" is required.' }, 400, request);
        const limit = parseLimit(body.limitUsd);
        if (limit.invalid) return jsonResponse({ error: '"limitUsd" must be a non-negative number or null.' }, 400, request);

        const existing = await registry.getMember(email);
        const apiKey = generateKey();
        const record = await registry.upsertMember({
            email, keyHash: await hashKey(apiKey),
            limitUsd: limit.present ? limit.value : undefined,
            actor: auth.actor,
        });
        memberCache.clear(); // an old key must stop working immediately after rotation
        console.log(`[GATEWAY] ${auth.actor} ${existing ? 'rotated key for' : 'created member'} ${email}`);
        return jsonResponse({
            email,
            apiKey,                  // shown once; only its hash is stored
            rotated: Boolean(existing),
            limitUsd: limitFor(record, cfg),
            note: 'Store this key now; it cannot be retrieved later.',
        }, existing ? 200 : 201, request);
    }

    // GET /admin/members
    if (!segments[2] && request.method === 'GET') {
        const month = url.searchParams.get('month') || monthKey(new Date(), cfg.timeZone);
        if (!/^\d{4}-\d{2}$/.test(month)) return jsonResponse({ error: '"month" must look like YYYY-MM.' }, 400, request);
        const members = await registry.listMembers();
        const rows = await Promise.all(members.map(m => memberView(env, m, month, cfg)));
        const totalUsd = roundUsd(rows.reduce((sum, r) => sum + r.spentUsd, 0));
        return jsonResponse({ month, defaultLimitUsd: cfg.defaultLimitUsd, totalSpentUsd: totalUsd, members: rows }, 200, request);
    }

    if (!targetEmail) return jsonResponse({ error: 'Invalid member email in path.' }, 400, request);
    const record = await registry.getMember(targetEmail);
    if (!record) return jsonResponse({ error: 'Member not found.' }, 404, request);

    // GET /admin/members/:email
    if (request.method === 'GET') {
        const month = monthKey(new Date(), cfg.timeZone);
        const view = await memberView(env, record, month, cfg);
        const history = await ledgerStub(env, targetEmail).history();
        return jsonResponse({ ...view, history }, 200, request);
    }

    // PATCH /admin/members/:email
    if (request.method === 'PATCH') {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Body must be JSON.' }, 400, request); }
        const patch = {};
        if (body.active !== undefined) {
            if (typeof body.active !== 'boolean') return jsonResponse({ error: '"active" must be a boolean.' }, 400, request);
            patch.active = body.active;
        }
        const limit = parseLimit(body.limitUsd);
        if (limit.invalid) return jsonResponse({ error: '"limitUsd" must be a non-negative number or null.' }, 400, request);
        if (limit.present) patch.limitUsd = limit.value;
        if (!Object.keys(patch).length) return jsonResponse({ error: 'Nothing to update.' }, 400, request);

        const updated = await registry.updateMember(targetEmail, patch);
        memberCache.clear();
        console.log(`[GATEWAY] ${auth.actor} updated ${targetEmail}: ${JSON.stringify(patch)}`);
        const month = monthKey(new Date(), cfg.timeZone);
        return jsonResponse(await memberView(env, updated, month, cfg), 200, request);
    }

    // DELETE /admin/members/:email
    if (request.method === 'DELETE') {
        const updated = await registry.updateMember(targetEmail, { active: false });
        memberCache.clear();
        console.log(`[GATEWAY] ${auth.actor} revoked ${targetEmail}`);
        const month = monthKey(new Date(), cfg.timeZone);
        return jsonResponse(await memberView(env, updated, month, cfg), 200, request);
    }

    return jsonResponse({ error: 'Method not allowed.' }, 405, request);
}

// --- Entry -------------------------------------------------------------------------------------

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return handleOptions(request);

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        try {
            if (path === '/' && request.method === 'GET') {
                return jsonResponse({ name: 'Vertex Gateway', version: VERSION, upstream: 'cloudflare-workers-ai', routes: Object.keys(PROXIED_ROUTES).concat(['/v1/me']) }, 200, request);
            }
            if (path === '/health') {
                return jsonResponse({ ok: true, version: VERSION }, 200, request);
            }
            if (path === '/admin' || path.startsWith('/admin/')) {
                return await handleAdmin(request, path, env);
            }

            if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
                console.error('[GATEWAY] CRITICAL: CF_API_TOKEN / CF_ACCOUNT_ID secrets are not set.');
                return errorResponse(request, 503, 'Gateway is not configured.', 'gateway_unconfigured', 'api_error');
            }

            if (path === '/v1/me' && request.method === 'GET') {
                const { member, error } = await authenticateMember(request, env);
                if (error) return error;
                return await handleMe(request, env, member);
            }

            const allowedMethods = PROXIED_ROUTES[path];
            if (!allowedMethods) {
                return errorResponse(request, 404, `No such route: ${request.method} ${path}`, 'not_found', 'invalid_request_error');
            }
            if (!allowedMethods.includes(request.method)) {
                return errorResponse(request, 405, `Method ${request.method} not allowed for ${path}`, 'method_not_allowed', 'invalid_request_error');
            }

            const { member, error } = await authenticateMember(request, env);
            if (error) return error;
            if (path === '/v1/models') return await handleModels(request, env);
            return await handleProxy(request, path, env, ctx, member);
        } catch (e) {
            console.error(`[GATEWAY] Unhandled error on ${request.method} ${path}: ${e.message}`, e.stack);
            return errorResponse(request, 500, 'Internal gateway error.', 'internal_error', 'api_error');
        }
    },
};
