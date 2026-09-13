/*
 * Vertex Gateway Worker - v1.0
 * A metered proxy in front of OpenRouter for the Array department.
 *
 * One company OpenRouter key stays secret inside the worker. Every member gets a personal gateway
 * key (`vxg_...`); the worker forwards their requests upstream, reads the cost OpenRouter reports
 * for each generation, and stops forwarding once the member's calendar-month spend reaches their
 * budget (MONTHLY_LIMIT_USD, overridable per member). Budgets reset on the 1st of the month in
 * QUOTA_TIMEZONE.
 *
 * Routes
 *   GET  /                      service info
 *   GET  /health                liveness
 *   GET  /v1/me                 caller's budget for the current month
 *   POST /v1/chat/completions   } proxied to OpenRouter and metered
 *   POST /v1/completions        }
 *   POST /v1/messages           }  (Anthropic-compatible; accepts x-api-key)
 *   POST /v1/responses          }
 *   POST /v1/embeddings         }
 *   GET  /v1/models             proxied, free
 *   POST   /admin/members            create a member or rotate their key   { email, limitUsd? }
 *   GET    /admin/members            list members with current-month spend (?month=YYYY-MM)
 *   GET    /admin/members/:email     one member with full history
 *   PATCH  /admin/members/:email     { active?, limitUsd? }
 *   DELETE /admin/members/:email     revoke (deactivate) a member
 */

import { Registry } from './durable/registry.js';
import { Ledger } from './durable/ledger.js';
import { verifyAdmin } from './lib/auth.js';
import { generateKey, hashKey, extractCredential, normalizeEmail, KEY_PREFIX } from './lib/keys.js';
import { monthKey, monthResetAt, parseUsd, roundUsd } from './lib/quota.js';
import { jsonResponse, errorResponse, handleOptions } from './lib/response.js';
import { extractUsage, mergeUsage, emptyUsage, meterStream } from './lib/sse.js';
import { PROXIED_ROUTES, FREE_ROUTES, buildUpstreamRequest, clientResponseHeaders, lookupGenerationCost, parseAllowlist, parseAliases } from './lib/upstream.js';

export { Registry, Ledger };

const VERSION = '1.0.0';
const DEFAULT_LIMIT_USD = 25;
const MEMBER_CACHE_TTL_MS = 30 * 1000; // revocations take effect within this window

// key hash -> { member, expiresAt } (per isolate)
const memberCache = new Map();

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
    };
}

function limitFor(member, cfg) {
    return typeof member.limitUsd === 'number' ? member.limitUsd : cfg.defaultLimitUsd;
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

async function settleUsage(env, email, month, summary, requestedModel) {
    let cost = summary.cost;
    if (cost == null && summary.id) {
        cost = await lookupGenerationCost(summary.id, env);
    }
    const usage = await ledgerStub(env, email).settle({
        month,
        costUsd: cost,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        model: summary.model || requestedModel,
    });
    console.log(`[GATEWAY] ${email} ${summary.model || requestedModel || '?'} cost=${cost == null ? 'unknown' : cost.toFixed(6)} month=${month} spent=${usage.spentUsd.toFixed(4)}`);
}

async function handleProxy(request, path, env, ctx, member) {
    const cfg = settings(env);
    const month = monthKey(new Date(), cfg.timeZone);
    const limitUsd = limitFor(member, cfg);
    const free = FREE_ROUTES.has(path);

    let quota = { spentUsd: 0, limitUsd, remainingUsd: limitUsd };
    if (!free) {
        quota = await ledgerStub(env, member.email).authorize({ month, limitUsd });
        if (!quota.ok) {
            return errorResponse(
                request, 402,
                `Monthly budget exhausted: $${quota.spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} used. Resets ${monthResetAt(month, cfg.timeZone).toISOString()}.`,
                'budget_exhausted', 'billing_error', quotaHeaders(quota, month, cfg),
            );
        }
    }

    const built = await buildUpstreamRequest(request, path, env, cfg);
    if (built.error) {
        return errorResponse(request, built.status, built.error, built.code, 'invalid_request_error');
    }

    let upstream;
    try {
        upstream = await fetch(built.request);
    } catch (e) {
        console.error(`[GATEWAY] upstream fetch failed: ${e.message}`);
        return errorResponse(request, 502, 'Upstream provider is unreachable.', 'upstream_unreachable', 'api_error');
    }

    const headers = clientResponseHeaders(upstream, quotaHeaders(quota, month, cfg));

    // Errors (and free routes) cost nothing: pass them straight through.
    if (free || !upstream.ok || !upstream.body) {
        return new Response(upstream.body, { status: upstream.status, headers });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
        const { clientBody, summary } = meterStream(upstream.body);
        ctx.waitUntil(summary.then(s => settleUsage(env, member.email, month, s, built.model)));
        return new Response(clientBody, { status: upstream.status, headers });
    }

    const text = await upstream.text();
    let summary = emptyUsage();
    try { summary = mergeUsage(summary, extractUsage(JSON.parse(text))); } catch { /* non-JSON success body; unpriced */ }
    ctx.waitUntil(settleUsage(env, member.email, month, summary, built.model));
    return new Response(text, { status: upstream.status, headers });
}

function quotaHeaders(quota, month, cfg) {
    return {
        'X-Gateway-Budget-Limit-Usd': String(quota.limitUsd),
        'X-Gateway-Budget-Spent-Usd': String(roundUsd(quota.spentUsd)),
        'X-Gateway-Budget-Resets-At': monthResetAt(month, cfg.timeZone).toISOString(),
    };
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
        lastAt: usage.lastAt,
    };
}

async function handleAdmin(request, path, env) {
    const auth = await verifyAdmin(request, env);
    if (!auth.ok) return jsonResponse({ error: auth.error }, 401, request);

    const cfg = settings(env);
    const url = new URL(request.url);
    const registry = registryStub(env);
    const segments = path.split('/').filter(Boolean); // ['admin', 'members', ':email'?]

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
                return jsonResponse({ name: 'Vertex Gateway', version: VERSION, routes: Object.keys(PROXIED_ROUTES).concat(['/v1/me']) }, 200, request);
            }
            if (path === '/health') {
                return jsonResponse({ ok: true, version: VERSION }, 200, request);
            }
            if (path === '/admin' || path.startsWith('/admin/')) {
                return await handleAdmin(request, path, env);
            }

            if (!env.OPENROUTER_KEY) {
                console.error('[GATEWAY] CRITICAL: OPENROUTER_KEY secret is not set.');
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
            return await handleProxy(request, path, env, ctx, member);
        } catch (e) {
            console.error(`[GATEWAY] Unhandled error on ${request.method} ${path}: ${e.message}`, e.stack);
            return errorResponse(request, 500, 'Internal gateway error.', 'internal_error', 'api_error');
        }
    },
};
