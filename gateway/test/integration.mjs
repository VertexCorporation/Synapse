/*
 * End-to-end check against a local `wrangler dev` with a fake Cloudflare API behind it.
 * Run: npm run test:integration   (no Cloudflare login needed; everything is local)
 */

import http from 'node:http';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PRICES } from '../lib/pricing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_PORT = 8791;
const ADMIN_TOKEN = 'test-admin-token';
const ACCOUNT = 'acc-test';
const CF_TOKEN = 'cf-token-test';

// --- Fake Cloudflare API (models/search + Workers AI OpenAI-compatible endpoints) -----------------

const CATALOG = [
    { name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', task: { name: 'Text Generation' }, properties: [{ property_id: 'context_window', value: '24000' }, { property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.30, currency: 'USD' }, { unit: 'per M output tokens', price: 2.30, currency: 'USD' }] }] },
    { name: '@cf/test/live-model', task: { name: 'Text Generation' }, properties: [{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 1, currency: 'USD' }, { unit: 'per M output tokens', price: 2, currency: 'USD' }] }] },
    { name: '@cf/test/no-usage', task: { name: 'Text Generation' }, properties: [{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 3, currency: 'USD' }, { unit: 'per M output tokens', price: 3, currency: 'USD' }] }] },
    { name: '@cf/test/embed', task: { name: 'Text Embeddings' }, properties: [{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.5, currency: 'USD' }] }] },
    { name: '@cf/black-forest-labs/flux-1-schnell', task: { name: 'Text-to-Image' }, properties: [{ property_id: 'price', value: [{ unit: 'per 512 by 512 tile', price: 0.0000528, currency: 'USD' }] }] },
];
let catalogFetches = 0;

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => resolve(data));
    });
}

const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
    }
    const prefix = `/client/v4/accounts/${ACCOUNT}/ai`;
    if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404); return res.end('{}');
    }
    const route = url.pathname.slice(prefix.length);

    if (route === '/models/search' && req.method === 'GET') {
        catalogFetches += 1;
        const page = Number(url.searchParams.get('page') || 1);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: true, result: page === 1 ? CATALOG : [] }));
    }

    const body = JSON.parse(await readBody(req) || '{}');
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;

    if (route === '/v1/chat/completions' && req.method === 'POST') {
        const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
        if (body.model === '@cf/test/live-model') Object.assign(usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const chunks = [
                { id, model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
                { id, model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'lo' } }] },
                { id, model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
            ];
            let i = 0;
            const tick = () => {
                if (i < chunks.length) { res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`); setTimeout(tick, 20); }
                else res.end('data: [DONE]\n\n');
            };
            return tick();
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
        const reply = { id, model: body.model, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: body.model === '@cf/test/no-usage' ? 'abcdefghijkl' : `echo:${body.messages?.[0]?.content}` }, finish_reason: 'stop' }] };
        if (body.model !== '@cf/test/no-usage') reply.usage = usage;   // this model "forgets" usage; the gateway must estimate
        return res.end(JSON.stringify(reply));
    }

    if (route === '/v1/embeddings' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', model: body.model, data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 10000, total_tokens: 10000 } }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, errors: [{ message: 'unknown upstream route' }] }));
});

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// --- Wrangler ------------------------------------------------------------------------------------

function startWrangler(upstreamPort) {
    // Vars go through an env file so JSON values survive Windows shell quoting.
    const envFile = path.join(ROOT, 'test', '.env.integration');
    fs.writeFileSync(envFile, [
        `CF_ACCOUNT_ID=${ACCOUNT}`,
        `CF_API_TOKEN=${CF_TOKEN}`,
        `CF_API_BASE=http://127.0.0.1:${upstreamPort}/client/v4`,
        `ADMIN_TOKEN=${ADMIN_TOKEN}`,
        'MONTHLY_LIMIT_USD=25',
        'MODEL_ALLOWLIST=@cf/',
        'MODEL_ALIASES={"llama":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"}',
        '',
    ].join('\n'));
    // Fresh Durable Object state every run.
    const stateDir = path.join(ROOT, 'test', '.wrangler-state');
    fs.rmSync(stateDir, { recursive: true, force: true });
    const args = ['wrangler', 'dev', '--port', String(GATEWAY_PORT), '--ip', '127.0.0.1', '--show-interactive-dev-session=false', '--env-file', envFile, '--persist-to', stateDir];
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write(`[wrangler] ${d}`));
    child.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(`[wrangler] ${d}`));
    return child;
}

async function waitForHealth(timeoutMs = 90000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('wrangler dev did not become healthy in time');
}

function stop(child) {
    if (!child || child.exitCode !== null) return;
    // Synchronous so the whole wrangler/workerd tree is gone before this process exits.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
}

// --- Helpers -------------------------------------------------------------------------------------

const gw = (p) => `http://127.0.0.1:${GATEWAY_PORT}${p}`;

async function admin(method, p, body) {
    const res = await fetch(gw(p), { method, headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
}

async function chat(key, body) {
    return fetch(gw('/v1/chat/completions'), { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function me(key) {
    const res = await fetch(gw('/v1/me'), { headers: { Authorization: `Bearer ${key}` } });
    return res.json();
}

async function waitForSpend(key, expected, timeoutMs = 15000) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = await me(key);
        if (Math.abs(last.spentUsd - expected) < 1e-9) return last;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`spend did not reach ${expected}; last seen ${JSON.stringify(last)}`);
}

// --- Scenarios -----------------------------------------------------------------------------------

async function run() {
    let passed = 0;
    const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };

    let key;
    await step('admin creates a member and receives the key once', async () => {
        const { status, json } = await admin('POST', '/admin/members', { email: 'Dev@VertexIsHere.com' });
        assert.equal(status, 201);
        assert.equal(json.email, 'dev@vertexishere.com');
        assert.match(json.apiKey, /^vxg_/);
        assert.equal(json.limitUsd, 25);
        key = json.apiKey;
    });

    await step('admin routes reject a wrong token', async () => {
        assert.equal((await fetch(gw('/admin/members'), { headers: { Authorization: 'Bearer nope' } })).status, 401);
    });

    await step('unknown and missing keys are refused', async () => {
        assert.equal((await fetch(gw('/v1/me'), { headers: { Authorization: 'Bearer vxg_unknown' } })).status, 401);
        assert.equal((await fetch(gw('/v1/me'))).status, 401);
        assert.equal((await fetch(gw('/v1/chat/completions'), { method: 'POST', headers: { 'x-api-key': 'vxg_unknown' }, body: '{}' })).status, 401);
    });

    await step('fresh member has an untouched budget', async () => {
        const status = await me(key);
        assert.equal(status.spentUsd, 0);
        assert.equal(status.remainingUsd, 25);
        assert.match(status.month, /^\d{4}-\d{2}$/);
    });

    await step('price catalog is fetched from Cloudflare once and served from cache', async () => {
        const first = await admin('GET', '/admin/catalog');
        assert.equal(first.status, 200);
        assert.equal(first.json.liveModels, 4, 'image model excluded');
        assert.equal(first.json.pricedModels, Object.keys(BUILTIN_PRICES).length + 3);
        const fetchesAfterFirst = catalogFetches;
        await admin('GET', '/admin/catalog');
        assert.equal(catalogFetches, fetchesAfterFirst, 'second call served from cache');
        const refreshed = await admin('GET', '/admin/catalog?refresh=1');
        assert.equal(catalogFetches, fetchesAfterFirst + 1, 'refresh=1 hits Cloudflare again');
        assert.equal(refreshed.json.sources.catalog, 4);
    });

    await step('non-streaming chat is proxied, passed through and priced from the live catalog', async () => {
        const res = await chat(key, { model: 'llama', messages: [{ role: 'user', content: 'ping' }] });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-request-id'), 'req-1');
        assert.equal(res.headers.get('x-gateway-budget-limit-usd'), '25');
        const body = await res.json();
        assert.equal(body.choices[0].message.content, 'echo:ping');
        assert.equal(body.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'); // alias applied upstream
        // 1000 in x $0.30/M + 500 out x $2.30/M — the catalog price, not the built-in 0.293/2.253
        const status = await waitForSpend(key, 0.00145);
        assert.equal(status.requests, 1);
        assert.equal(status.promptTokens, 1000);
        assert.equal(status.byModel['@cf/meta/llama-3.3-70b-instruct-fp8-fast'].requests, 1);
    });

    await step('streaming chat reaches the client unchanged and is priced from the final chunk', async () => {
        const res = await chat(key, { model: '@cf/test/live-model', messages: [{ role: 'user', content: 'ping' }], stream: true });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        const text = await res.text();
        assert.ok(text.includes('"content":"Hel"') && text.includes('"content":"lo"') && text.trim().endsWith('data: [DONE]'));
        await waitForSpend(key, 0.00165); // + 100 x $1/M + 50 x $2/M
    });

    await step('a response without a usage block is estimated from characters, never skipped', async () => {
        const res = await chat(key, { model: '@cf/test/no-usage', messages: [{ role: 'user', content: 'hello world' }] });
        assert.equal(res.status, 200);
        // 11 prompt chars -> 4 tokens, 12 reply chars -> 4 tokens, $3/M each way
        const status = await waitForSpend(key, 0.001674);
        assert.equal(status.estimatedRequests, 1);
        assert.equal(status.unpricedRequests, 0);
    });

    await step('unpriced and disallowed models are refused before spending', async () => {
        const unpriced = await chat(key, { model: '@cf/nobody/unknown', messages: [] });
        assert.equal(unpriced.status, 403);
        assert.equal((await unpriced.json()).error.code, 'model_not_priced');
        const disallowed = await chat(key, { model: 'openai/gpt-4o', messages: [] });
        assert.equal(disallowed.status, 403);
        assert.equal((await disallowed.json()).error.code, 'model_not_allowed');
        assert.equal((await me(key)).spentUsd, 0.001674);
    });

    await step('/v1/models lists every priced model and is free', async () => {
        const res = await fetch(gw('/v1/models'), { headers: { Authorization: `Bearer ${key}` } });
        assert.equal(res.status, 200);
        const list = await res.json();
        assert.equal(list.object, 'list');
        assert.equal(list.data.length, Object.keys(BUILTIN_PRICES).length + 3);
        const llama = list.data.find(m => m.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
        assert.deepEqual(llama.pricing, { currency: 'USD', input_per_million: 0.30, output_per_million: 2.30, source: 'catalog' });
        assert.equal(list.data.find(m => m.id === '@cf/test/embed').kind, 'embedding');
        assert.equal((await me(key)).spentUsd, 0.001674);
    });

    await step('embeddings are proxied and priced on input tokens', async () => {
        const res = await fetch(gw('/v1/embeddings'), { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: '@cf/baai/bge-m3', input: 'some text' }) });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).data[0].object, 'embedding');
        await waitForSpend(key, 0.001794); // + 10000 x $0.012/M (built-in price)
    });

    let tightKey;
    await step('a member with a custom limit is cut off once it is reached', async () => {
        const created = await admin('POST', '/admin/members', { email: 'tight@vertexishere.com', limitUsd: 0.002 });
        assert.equal(created.status, 201);
        tightKey = created.json.apiKey;
        const first = await chat(tightKey, { model: '@cf/test/live-model', messages: [{ role: 'user', content: 'x' }] });
        assert.equal(first.status, 200);
        await waitForSpend(tightKey, 0.0002);
        for (let i = 0; i < 9; i++) {
            const res = await chat(tightKey, { model: '@cf/test/live-model', messages: [{ role: 'user', content: 'x' }] });
            assert.equal(res.status, 200, `request ${i + 2} still under the limit`);
            await waitForSpend(tightKey, 0.0002 * (i + 2));
        }
        const blocked = await chat(tightKey, { model: '@cf/test/live-model', messages: [{ role: 'user', content: 'x' }] });
        assert.equal(blocked.status, 402);
        const err = await blocked.json();
        assert.equal(err.error.code, 'budget_exhausted');
        assert.equal(blocked.headers.get('x-gateway-budget-spent-usd'), '0.002');
    });

    await step('raising the limit re-opens the tap', async () => {
        const patched = await admin('PATCH', '/admin/members/tight%40vertexishere.com', { limitUsd: 1 });
        assert.equal(patched.status, 200);
        assert.equal(patched.json.limitUsd, 1);
        const res = await chat(tightKey, { model: '@cf/test/live-model', messages: [{ role: 'user', content: 'x' }] });
        assert.equal(res.status, 200);
        await waitForSpend(tightKey, 0.0022);
    });

    await step('admin listing aggregates spend', async () => {
        const { status, json } = await admin('GET', '/admin/members');
        assert.equal(status, 200);
        assert.equal(json.members.length, 2);
        assert.equal(json.totalSpentUsd, 0.003994);
        assert.ok(json.members.every(m => m.keyHash === undefined), 'hashes never leave the worker');
        const detail = await admin('GET', '/admin/members/dev%40vertexishere.com');
        assert.equal(detail.status, 200);
        assert.equal(detail.json.history.length, 1);
    });

    await step('rotating a key invalidates the old one immediately', async () => {
        const rotated = await admin('POST', '/admin/members', { email: 'dev@vertexishere.com' });
        assert.equal(rotated.status, 200);
        assert.equal(rotated.json.rotated, true);
        assert.equal((await fetch(gw('/v1/me'), { headers: { Authorization: `Bearer ${key}` } })).status, 401);
        key = rotated.json.apiKey;
        assert.equal((await me(key)).spentUsd, 0.001794, 'spend survives rotation');
    });

    await step('revoking a member blocks further use and can be undone', async () => {
        const revoked = await admin('DELETE', '/admin/members/dev%40vertexishere.com');
        assert.equal(revoked.status, 200);
        assert.equal(revoked.json.active, false);
        const res = await fetch(gw('/v1/me'), { headers: { Authorization: `Bearer ${key}` } });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error.code, 'key_revoked');
        const restored = await admin('PATCH', '/admin/members/dev%40vertexishere.com', { active: true });
        assert.equal(restored.json.active, true);
        assert.equal((await fetch(gw('/v1/me'), { headers: { Authorization: `Bearer ${key}` } })).status, 200);
    });

    await step('unknown routes and methods are refused without touching upstream', async () => {
        assert.equal((await fetch(gw('/v1/messages'), { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).status, 404);
        assert.equal((await fetch(gw('/v1/chat/completions'), { headers: { Authorization: `Bearer ${key}` } })).status, 405);
    });

    console.log(`\n${passed} integration steps passed`);
}

// --- Main ----------------------------------------------------------------------------------------

const upstreamPort = await listen(upstream);
const wrangler = startWrangler(upstreamPort);
let exitCode = 0;
try {
    await waitForHealth();
    await run();
} catch (e) {
    exitCode = 1;
    console.error('\n✖ integration failed:', e.message);
} finally {
    stop(wrangler);
    upstream.close();
}
process.exit(exitCode);
