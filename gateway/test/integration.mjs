/*
 * End-to-end check against a local `wrangler dev` with a fake OpenRouter behind it.
 * Run: npm run test:integration   (no Cloudflare login needed; everything is local)
 */

import http from 'node:http';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_PORT = 8791;
const ADMIN_TOKEN = 'test-admin-token';
const GEN_COSTS = new Map(); // id -> cost reported by /api/v1/generation

// --- Fake OpenRouter -----------------------------------------------------------------------------

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => resolve(data));
    });
}

const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization;
    if (auth !== 'Bearer sk-company-test') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad upstream key', code: 401 } }));
    }

    if (url.pathname === '/api/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-sonnet-4.5' }] }));
    }

    if (url.pathname === '/api/v1/generation' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!GEN_COSTS.has(id)) { res.writeHead(404); return res.end('{}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: { id, total_cost: GEN_COSTS.get(id) } }));
    }

    const body = JSON.parse(await readBody(req) || '{}');
    const id = `gen-${Math.random().toString(36).slice(2, 10)}`;

    if (url.pathname === '/api/v1/chat/completions') {
        const cost = body.model === 'openai/gpt-4o' ? 0.0015 : 0.0004;
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const chunks = [
                { id, model: body.model, choices: [{ delta: { content: 'Hel' } }] },
                { id, model: body.model, choices: [{ delta: { content: 'lo' } }] },
                { id, model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, cost } },
            ];
            let i = 0;
            const tick = () => {
                if (i < chunks.length) {
                    res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
                    setTimeout(tick, 20);
                } else {
                    res.end('data: [DONE]\n\n');
                }
            };
            return tick();
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
        return res.end(JSON.stringify({ id, model: body.model, choices: [{ message: { role: 'assistant', content: `echo:${body.messages?.[0]?.content}` } }], usage: { prompt_tokens: 12, completion_tokens: 3, cost } }));
    }

    if (url.pathname === '/api/v1/messages') {
        // Anthropic shape: no cost in usage; the gateway must fall back to /generation.
        GEN_COSTS.set(id, 0.0025);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id, type: 'message', model: body.model, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unknown upstream route', code: 404 } }));
});

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// --- Wrangler ------------------------------------------------------------------------------------

function startWrangler(upstreamPort) {
    // Vars go through an env file so JSON values survive Windows shell quoting.
    const envFile = path.join(ROOT, 'test', '.env.integration');
    fs.writeFileSync(envFile, [
        'OPENROUTER_KEY=sk-company-test',
        `OPENROUTER_BASE=http://127.0.0.1:${upstreamPort}`,
        `ADMIN_TOKEN=${ADMIN_TOKEN}`,
        'MONTHLY_LIMIT_USD=25',
        'MODEL_ALLOWLIST=openai/,anthropic/',
        'MODEL_ALIASES={"gpt":"openai/gpt-4o"}',
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
        const res = await fetch(gw('/admin/members'), { headers: { Authorization: 'Bearer nope' } });
        assert.equal(res.status, 401);
    });

    await step('unknown and missing keys are refused', async () => {
        assert.equal((await fetch(gw('/v1/me'), { headers: { Authorization: 'Bearer vxg_unknown' } })).status, 401);
        assert.equal((await fetch(gw('/v1/me'))).status, 401);
        const anthropic = await fetch(gw('/v1/messages'), { method: 'POST', headers: { 'x-api-key': 'vxg_unknown' }, body: '{}' });
        assert.equal(anthropic.status, 401);
        assert.equal((await anthropic.json()).type, 'error');
    });

    await step('fresh member has an untouched budget', async () => {
        const status = await me(key);
        assert.equal(status.spentUsd, 0);
        assert.equal(status.remainingUsd, 25);
        assert.match(status.month, /^\d{4}-\d{2}$/);
    });

    await step('non-streaming chat is proxied, passed through and metered', async () => {
        const res = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'ping' }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-request-id'), 'req-1');
        assert.equal(res.headers.get('x-gateway-budget-limit-usd'), '25');
        const body = await res.json();
        assert.equal(body.choices[0].message.content, 'echo:ping');
        assert.equal(body.model, 'openai/gpt-4o'); // alias applied upstream
        const status = await waitForSpend(key, 0.0015);
        assert.equal(status.requests, 1);
        assert.equal(status.byModel['openai/gpt-4o'].requests, 1);
    });

    await step('streaming chat reaches the client unchanged and is metered from the final chunk', async () => {
        const res = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'ping' }], stream: true }),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        const text = await res.text();
        assert.ok(text.includes('"content":"Hel"') && text.includes('"content":"lo"') && text.trim().endsWith('data: [DONE]'));
        await waitForSpend(key, 0.0019);
    });

    await step('Anthropic-style request via x-api-key uses the generation fallback for cost', async () => {
        const res = await fetch(gw('/v1/messages'), {
            method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.5', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).type, 'message');
        await waitForSpend(key, 0.0044);
    });

    await step('models outside the allowlist are refused before spending', async () => {
        const res = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'x-ai/grok-4', messages: [] }),
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error.code, 'model_not_allowed');
    });

    await step('/v1/models is free', async () => {
        const res = await fetch(gw('/v1/models'), { headers: { Authorization: `Bearer ${key}` } });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).data.length, 2);
        assert.equal((await me(key)).spentUsd, 0.0044);
    });

    let tightKey;
    await step('a member with a custom limit is cut off once it is reached', async () => {
        const created = await admin('POST', '/admin/members', { email: 'tight@vertexishere.com', limitUsd: 0.002 });
        assert.equal(created.status, 201);
        tightKey = created.json.apiKey;
        const first = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${tightKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
        });
        assert.equal(first.status, 200);
        await waitForSpend(tightKey, 0.0015);
        const second = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${tightKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
        });
        assert.equal(second.status, 200, 'still under the limit');
        await waitForSpend(tightKey, 0.003);
        const third = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${tightKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
        });
        assert.equal(third.status, 402);
        const err = await third.json();
        assert.equal(err.error.code, 'budget_exhausted');
        assert.equal(third.headers.get('x-gateway-budget-spent-usd'), '0.003');
        const anthropic = await fetch(gw('/v1/messages'), { method: 'POST', headers: { 'x-api-key': tightKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.5', messages: [] }) });
        assert.equal(anthropic.status, 402);
        assert.equal((await anthropic.json()).error.type, 'budget_exhausted');
    });

    await step('raising the limit re-opens the tap', async () => {
        const patched = await admin('PATCH', '/admin/members/tight%40vertexishere.com', { limitUsd: 1 });
        assert.equal(patched.status, 200);
        assert.equal(patched.json.limitUsd, 1);
        const res = await fetch(gw('/v1/chat/completions'), {
            method: 'POST', headers: { Authorization: `Bearer ${tightKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
        });
        assert.equal(res.status, 200);
        await waitForSpend(tightKey, 0.0045);
    });

    await step('admin listing aggregates spend', async () => {
        const { status, json } = await admin('GET', '/admin/members');
        assert.equal(status, 200);
        assert.equal(json.members.length, 2);
        assert.equal(json.totalSpentUsd, 0.0089);
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
        const status = await me(key);
        assert.equal(status.spentUsd, 0.0044, 'spend survives rotation');
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
        assert.equal((await fetch(gw('/v1/images/generations'), { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).status, 404);
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
