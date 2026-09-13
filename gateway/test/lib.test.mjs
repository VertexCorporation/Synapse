import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monthKey, monthResetAt, parseUsd, roundUsd } from '../lib/quota.js';
import { generateKey, hashKey, extractCredential, safeEqual, normalizeEmail, KEY_PREFIX } from '../lib/keys.js';
import { extractUsage, mergeUsage, emptyUsage, UsageScanner, meterStream } from '../lib/sse.js';
import { resolveModel, parseAllowlist, parseAliases, buildUpstreamRequest, clientResponseHeaders } from '../lib/upstream.js';

// --- quota ---------------------------------------------------------------------------------------

test('monthKey follows the configured zone, not UTC', () => {
    // 2026-08-31 22:30 UTC is already 2026-09-01 01:30 in Istanbul (UTC+3).
    const instant = new Date('2026-08-31T22:30:00Z');
    assert.equal(monthKey(instant, 'Europe/Istanbul'), '2026-09');
    assert.equal(monthKey(instant, 'UTC'), '2026-08');
});

test('monthResetAt is local midnight on the 1st of the next month', () => {
    assert.equal(monthResetAt('2026-09', 'Europe/Istanbul').toISOString(), '2026-09-30T21:00:00.000Z');
    assert.equal(monthResetAt('2026-12', 'UTC').toISOString(), '2027-01-01T00:00:00.000Z');
});

test('parseUsd and roundUsd', () => {
    assert.equal(parseUsd('25', 1), 25);
    assert.equal(parseUsd('nope', 1), 1);
    assert.equal(parseUsd(-3, 1), 1);
    assert.equal(roundUsd(0.1 + 0.2), 0.3);
});

// --- keys ----------------------------------------------------------------------------------------

test('generated keys are prefixed, unique and hash deterministically', async () => {
    const a = generateKey();
    const b = generateKey();
    assert.ok(a.startsWith(KEY_PREFIX));
    assert.notEqual(a, b);
    assert.equal(await hashKey(a), await hashKey(a));
    assert.notEqual(await hashKey(a), await hashKey(b));
    assert.match(await hashKey(a), /^[0-9a-f]{64}$/);
});

test('extractCredential reads Bearer and x-api-key headers', () => {
    assert.equal(extractCredential(new Request('http://x', { headers: { Authorization: 'Bearer abc' } })), 'abc');
    assert.equal(extractCredential(new Request('http://x', { headers: { 'x-api-key': 'xyz' } })), 'xyz');
    assert.equal(extractCredential(new Request('http://x', { headers: { Authorization: 'Basic abc' } })), null);
    assert.equal(extractCredential(new Request('http://x')), null);
});

test('safeEqual and normalizeEmail', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(normalizeEmail('  Uras@VertexIsHere.com '), 'uras@vertexishere.com');
    assert.equal(normalizeEmail('not an email'), null);
    assert.equal(normalizeEmail(42), null);
});

// --- usage extraction ----------------------------------------------------------------------------

test('extractUsage handles OpenAI, Anthropic and Responses shapes', () => {
    assert.deepEqual(extractUsage({ id: 'gen-1', model: 'openai/gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 } }),
        { cost: 0.0012, promptTokens: 10, completionTokens: 5, id: 'gen-1', model: 'openai/gpt-4o' });
    assert.deepEqual(extractUsage({ type: 'message_start', message: { id: 'gen-2', model: 'anthropic/claude', usage: { input_tokens: 7, output_tokens: 1 } } }),
        { cost: null, promptTokens: 7, completionTokens: 1, id: 'gen-2', model: 'anthropic/claude' });
    assert.deepEqual(extractUsage({ type: 'message_delta', usage: { output_tokens: 42, cost: 0.5 } }),
        { cost: 0.5, promptTokens: null, completionTokens: 42, id: null, model: null });
    assert.deepEqual(extractUsage({ type: 'response.completed', response: { id: 'gen-3', usage: { input_tokens: 3, output_tokens: 4, cost: 0.01 } } }),
        { cost: 0.01, promptTokens: 3, completionTokens: 4, id: 'gen-3', model: null });
    assert.equal(extractUsage({ choices: [] }), null);
    assert.equal(extractUsage(null), null);
});

test('mergeUsage keeps the first id, the last cost and the largest token counts', () => {
    let s = emptyUsage();
    s = mergeUsage(s, { cost: null, promptTokens: 7, completionTokens: 1, id: 'gen-a', model: 'm' });
    s = mergeUsage(s, { cost: 0.2, promptTokens: null, completionTokens: 40, id: 'gen-b', model: null });
    assert.deepEqual(s, { cost: 0.2, promptTokens: 7, completionTokens: 40, id: 'gen-a', model: 'm' });
});

test('UsageScanner reads usage from an SSE stream split at arbitrary byte boundaries', () => {
    const sse = [
        'data: {"id":"gen-9","model":"openai/gpt-4o","choices":[{"delta":{"content":"He"}}]}',
        '',
        'data: {"id":"gen-9","choices":[{"delta":{"content":"llo"}}]}',
        '',
        'data: {"id":"gen-9","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"cost":0.00042}}',
        '',
        'data: [DONE]',
        '',
    ].join('\n');
    const bytes = new TextEncoder().encode(sse);
    for (const size of [1, 7, 64, bytes.length]) {
        const scanner = new UsageScanner();
        for (let i = 0; i < bytes.length; i += size) scanner.feed(bytes.slice(i, i + size));
        const summary = scanner.finish();
        assert.deepEqual(summary, { cost: 0.00042, promptTokens: 12, completionTokens: 2, id: 'gen-9', model: 'openai/gpt-4o' }, `chunk size ${size}`);
    }
});

test('UsageScanner understands Anthropic streams (message_start + message_delta)', () => {
    const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"gen-77","model":"anthropic/claude-sonnet-4.5","usage":{"input_tokens":25,"output_tokens":1}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,"cost":0.0031}}',
        '',
    ].join('\n');
    const scanner = new UsageScanner();
    scanner.feed(new TextEncoder().encode(sse));
    assert.deepEqual(scanner.finish(), { cost: 0.0031, promptTokens: 25, completionTokens: 9, id: 'gen-77', model: 'anthropic/claude-sonnet-4.5' });
});

test('meterStream passes bytes through unchanged and reports usage when the stream ends', async () => {
    const chunks = ['data: {"id":"gen-5","usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}\n\n', 'data: [DONE]\n\n'];
    const body = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
        },
    });
    const { clientBody, summary } = meterStream(body);
    const received = await new Response(clientBody).text();
    assert.equal(received, chunks.join(''));
    assert.deepEqual(await summary, { cost: 0.001, promptTokens: 1, completionTokens: 1, id: 'gen-5', model: null });
});

// --- upstream ------------------------------------------------------------------------------------

test('resolveModel applies aliases then the allowlist (exact ids and prefixes)', () => {
    const allowlist = parseAllowlist(' anthropic/ , openai/gpt-4o ');
    const aliases = parseAliases('{"claude-sonnet-4-5":"anthropic/claude-sonnet-4.5"}');
    assert.deepEqual(resolveModel('claude-sonnet-4-5', allowlist, aliases), { model: 'anthropic/claude-sonnet-4.5', allowed: true });
    assert.deepEqual(resolveModel('openai/gpt-4o', allowlist, aliases), { model: 'openai/gpt-4o', allowed: true });
    assert.deepEqual(resolveModel('openai/gpt-4o-mini', allowlist, aliases), { model: 'openai/gpt-4o-mini', allowed: false });
    assert.deepEqual(resolveModel('x-ai/grok', [], {}), { model: 'x-ai/grok', allowed: true });
    assert.deepEqual(resolveModel(undefined, allowlist, aliases), { model: undefined, allowed: true });
    assert.deepEqual(parseAliases('not json'), {});
});

test('buildUpstreamRequest swaps credentials, rewrites the model and keeps the body otherwise intact', async () => {
    const env = { OPENROUTER_BASE: 'https://upstream.test/', OPENROUTER_KEY: 'sk-company', OPENROUTER_REFERER: 'https://vertexishere.com', OPENROUTER_TITLE: 'T' };
    const incoming = new Request('https://gw.test/v1/chat/completions?x=1', {
        method: 'POST',
        headers: { Authorization: 'Bearer vxg_member', 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const built = await buildUpstreamRequest(incoming, '/v1/chat/completions', env, { allowlist: [], aliases: { gpt: 'openai/gpt-4o' } });
    assert.equal(built.request.url, 'https://upstream.test/api/v1/chat/completions?x=1');
    assert.equal(built.request.headers.get('authorization'), 'Bearer sk-company');
    assert.equal(built.request.headers.get('http-referer'), 'https://vertexishere.com');
    assert.equal(built.request.headers.get('x-title'), 'T');
    assert.equal(built.request.headers.get('anthropic-version'), '2023-06-01');
    assert.equal(built.request.headers.get('x-forwarded-for'), null);
    assert.equal(built.model, 'openai/gpt-4o');
    assert.equal(built.stream, true);
    const body = await built.request.json();
    assert.deepEqual(body, { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
});

test('buildUpstreamRequest refuses models outside the allowlist', async () => {
    const env = { OPENROUTER_KEY: 'k' };
    const incoming = new Request('https://gw.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'x-ai/grok' }) });
    const built = await buildUpstreamRequest(incoming, '/v1/chat/completions', env, { allowlist: ['anthropic/'], aliases: {} });
    assert.equal(built.status, 403);
    assert.equal(built.code, 'model_not_allowed');
});

test('clientResponseHeaders drops hop-by-hop headers and adds extras', () => {
    const upstream = new Response('', { headers: { 'content-type': 'application/json', 'content-length': '2', 'set-cookie': 'a=b', 'x-request-id': 'r1' } });
    const headers = clientResponseHeaders(upstream, { 'X-Gateway-Budget-Limit-Usd': '25' });
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-request-id'), 'r1');
    assert.equal(headers.get('content-length'), null);
    assert.equal(headers.get('set-cookie'), null);
    assert.equal(headers.get('x-gateway-budget-limit-usd'), '25');
});
