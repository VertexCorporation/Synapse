import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monthKey, monthResetAt, parseUsd, roundUsd } from '../lib/quota.js';
import { generateKey, hashKey, extractCredential, safeEqual, normalizeEmail, KEY_PREFIX } from '../lib/keys.js';
import { extractUsage, mergeUsage, emptyUsage, UsageScanner, meterStream, contentChars } from '../lib/sse.js';
import { resolveModel, parseAllowlist, parseAliases, buildUpstreamRequest, clientResponseHeaders, promptText } from '../lib/upstream.js';
import { pricesFromProperty, catalogEntry, priceFor, costFor, costFromNeurons, estimateTokens, estimateTokensFromChars, parsePriceOverrides, listPricedModels, BUILTIN_PRICES } from '../lib/pricing.js';

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

test('extractUsage reads OpenAI usage blocks and counts generated characters', () => {
    assert.deepEqual(extractUsage({ id: 'chatcmpl-1', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', choices: [{ message: { role: 'assistant', content: 'Hello!' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { promptTokens: 10, completionTokens: 5, neurons: null, id: 'chatcmpl-1', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', chars: 6 });
    assert.deepEqual(extractUsage({ object: 'list', data: [], usage: { prompt_tokens: 7, total_tokens: 7, neurons: 0.5 } }),
        { promptTokens: 7, completionTokens: null, neurons: 0.5, id: null, model: null, chars: 0 });
    assert.equal(extractUsage({ foo: 'bar' }), null);
    assert.equal(extractUsage(null), null);
    assert.equal(contentChars({ choices: [{ delta: { content: 'ab' } }, { delta: { content: 'c' } }] }), 3);
});

test('mergeUsage keeps the first id, accumulates characters and the largest token counts', () => {
    let s = emptyUsage();
    s = mergeUsage(s, { promptTokens: 7, completionTokens: 1, neurons: null, id: 'a', model: 'm', chars: 2 });
    s = mergeUsage(s, { promptTokens: null, completionTokens: 40, neurons: 0.25, id: 'b', model: null, chars: 3 });
    assert.deepEqual(s, { promptTokens: 7, completionTokens: 40, neurons: 0.25, id: 'a', model: 'm', chars: 5 });
});

test('UsageScanner reads usage from an SSE stream split at arbitrary byte boundaries', () => {
    const sse = [
        'data: {"id":"c1","model":"@cf/openai/gpt-oss-20b","choices":[{"delta":{"content":"He"}}]}',
        '',
        'data: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}',
        '',
        'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}',
        '',
        'data: [DONE]',
        '',
    ].join('\n');
    const bytes = new TextEncoder().encode(sse);
    for (const size of [1, 7, 64, bytes.length]) {
        const scanner = new UsageScanner();
        for (let i = 0; i < bytes.length; i += size) scanner.feed(bytes.slice(i, i + size));
        const summary = scanner.finish();
        assert.deepEqual(summary, { promptTokens: 12, completionTokens: 2, neurons: null, id: 'c1', model: '@cf/openai/gpt-oss-20b', chars: 5 }, `chunk size ${size}`);
    }
});

test('meterStream passes bytes through unchanged and reports usage when the stream ends', async () => {
    const chunks = ['data: {"id":"c5","choices":[{"delta":{"content":"hey"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n', 'data: [DONE]\n\n'];
    const body = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
        },
    });
    const { clientBody, summary } = meterStream(body);
    const received = await new Response(clientBody).text();
    assert.equal(received, chunks.join(''));
    assert.deepEqual(await summary, { promptTokens: 1, completionTokens: 1, neurons: null, id: 'c5', model: null, chars: 3 });
});

// --- upstream ------------------------------------------------------------------------------------

test('resolveModel applies aliases then the allowlist (exact ids and prefixes)', () => {
    const allowlist = parseAllowlist(' @cf/meta/ , @cf/openai/gpt-oss-120b ');
    const aliases = parseAliases('{"llama":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"}');
    assert.deepEqual(resolveModel('llama', allowlist, aliases), { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', allowed: true });
    assert.deepEqual(resolveModel('@cf/openai/gpt-oss-120b', allowlist, aliases), { model: '@cf/openai/gpt-oss-120b', allowed: true });
    assert.deepEqual(resolveModel('@cf/openai/gpt-oss-20b', allowlist, aliases), { model: '@cf/openai/gpt-oss-20b', allowed: false });
    assert.deepEqual(resolveModel('@cf/qwen/qwq-32b', [], {}), { model: '@cf/qwen/qwq-32b', allowed: true });
    assert.deepEqual(parseAliases('not json'), {});
});

test('promptText gathers the billable input of chat and embedding bodies', () => {
    assert.equal(promptText({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), 'be brief\n[{"type":"text","text":"hi"}]');
    assert.equal(promptText({ input: ['a', 'bb'] }), 'a\nbb');
    assert.equal(promptText({ input: 'x' }), 'x');
    assert.equal(promptText(null), '');
});

test('buildUpstreamRequest targets the account endpoint, swaps credentials and rewrites the model', async () => {
    const env = { CF_API_BASE: 'https://cf.test/client/v4/', CF_ACCOUNT_ID: 'acc123', CF_API_TOKEN: 'cf-token' };
    const incoming = new Request('https://gw.test/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer vxg_member', 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify({ model: 'llama', messages: [{ role: 'user', content: 'hi there' }], stream: true }),
    });
    const built = await buildUpstreamRequest(incoming, '/v1/chat/completions', env, { allowlist: [], aliases: { llama: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } });
    assert.equal(built.request.url, 'https://cf.test/client/v4/accounts/acc123/ai/v1/chat/completions');
    assert.equal(built.request.headers.get('authorization'), 'Bearer cf-token');
    assert.equal(built.request.headers.get('x-forwarded-for'), null);
    assert.equal(built.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    assert.equal(built.stream, true);
    assert.equal(built.promptChars, 'hi there'.length);
    assert.deepEqual(await built.request.json(), { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: [{ role: 'user', content: 'hi there' }], stream: true });
});

test('buildUpstreamRequest refuses non-JSON bodies, missing models and models outside the allowlist', async () => {
    const env = { CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 'k' };
    const bad = await buildUpstreamRequest(new Request('https://gw.test/v1/chat/completions', { method: 'POST', body: 'nope' }), '/v1/chat/completions', env, { allowlist: [], aliases: {} });
    assert.equal(bad.code, 'invalid_body');
    const noModel = await buildUpstreamRequest(new Request('https://gw.test/v1/chat/completions', { method: 'POST', body: '{"messages":[]}' }), '/v1/chat/completions', env, { allowlist: [], aliases: {} });
    assert.equal(noModel.code, 'model_required');
    const blocked = await buildUpstreamRequest(new Request('https://gw.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: '@cf/qwen/qwq-32b' }) }), '/v1/chat/completions', env, { allowlist: ['@cf/meta/'], aliases: {} });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.code, 'model_not_allowed');
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

// --- pricing -------------------------------------------------------------------------------------

test('pricesFromProperty reads USD per-million rows from the catalog price property', () => {
    assert.deepEqual(pricesFromProperty([
        { unit: 'per M input tokens', price: 0.293, currency: 'USD' },
        { unit: 'per M output tokens', price: 2.253, currency: 'USD' },
    ]), { inputPerM: 0.293, outputPerM: 2.253 });
    assert.deepEqual(pricesFromProperty([{ unit: 'per M input tokens', price: '0.012', currency: 'USD' }]), { inputPerM: 0.012, outputPerM: 0 });
    assert.deepEqual(pricesFromProperty([{ unit: 'per M tokens', price: 0.05 }]), { inputPerM: 0.05, outputPerM: 0.05 });
    assert.equal(pricesFromProperty([{ unit: 'per 512x512 tile', price: 0.001 }]), null);
    assert.equal(pricesFromProperty(undefined), null);
});

test('catalogEntry keeps priced chat and embedding models only', () => {
    const chat = catalogEntry({ name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', task: { name: 'Text Generation' }, properties: [{ property_id: 'context_window', value: '24000' }, { property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.293, currency: 'USD' }, { unit: 'per M output tokens', price: 2.253, currency: 'USD' }] }] });
    assert.deepEqual(chat, { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', kind: 'chat', description: null, contextWindow: 24000, inputPerM: 0.293, outputPerM: 2.253 });
    const embed = catalogEntry({ name: '@cf/baai/bge-m3', task: { name: 'Text Embeddings' }, properties: [{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.012, currency: 'USD' }] }] });
    assert.equal(embed.kind, 'embedding');
    assert.equal(embed.outputPerM, 0);
    assert.equal(catalogEntry({ name: '@cf/black-forest-labs/flux-1-schnell', task: { name: 'Text-to-Image' } }), null);
    assert.equal(catalogEntry({ name: '@cf/some/new-chat-model', task: { name: 'Text Generation' } }).inputPerM, null);
});

test('priceFor prefers overrides, then the live catalog, then the built-in table', () => {
    const catalog = [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', kind: 'chat', inputPerM: 0.30, outputPerM: 2.30 }, { id: '@cf/new/model', kind: 'chat', inputPerM: 1, outputPerM: 2 }];
    const overrides = parsePriceOverrides('{"@cf/meta/llama-3.3-70b-instruct-fp8-fast":{"input":0.1,"output":0.2},"bad":{"input":"x"}}');
    assert.deepEqual(priceFor('@cf/meta/llama-3.3-70b-instruct-fp8-fast', catalog, overrides), { inputPerM: 0.1, outputPerM: 0.2, source: 'override' });
    assert.deepEqual(priceFor('@cf/new/model', catalog, overrides), { inputPerM: 1, outputPerM: 2, source: 'catalog' });
    assert.deepEqual(priceFor('@cf/openai/gpt-oss-20b', catalog, overrides), { inputPerM: 0.2, outputPerM: 0.3, source: 'builtin' });
    assert.deepEqual(priceFor('@cf/openai/gpt-oss-20b', null, {}), { inputPerM: 0.2, outputPerM: 0.3, source: 'builtin' });
    assert.equal(priceFor('@cf/unknown/model', catalog, overrides), null);
    assert.equal(overrides.bad, undefined);
});

test('costFor, costFromNeurons and estimateTokens', () => {
    assert.equal(costFromNeurons(1000), 0.011);
    assert.equal(costFromNeurons(0.07827652152627707), 0.000000861);
    assert.equal(costFor({ inputPerM: 0.293, outputPerM: 2.253 }, 1000, 500), 0.0014195);
    assert.equal(costFor({ inputPerM: 0.012, outputPerM: 0 }, 2_000_000, 0), 0.024);
    assert.equal(estimateTokens('abcdef'), 2);
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokensFromChars(11), 4);
    assert.equal(estimateTokensFromChars(0), 0);
    assert.equal(estimateTokensFromChars(NaN), 0);
});

test('listPricedModels merges every source and keeps embeddings marked', () => {
    const models = listPricedModels([{ id: '@cf/new/model', kind: 'chat', inputPerM: 1, outputPerM: 2, contextWindow: 8000, description: 'new' }], parsePriceOverrides('{"@cf/custom/x":{"input":5}}'));
    const ids = models.map(m => m.id);
    assert.ok(ids.includes('@cf/new/model') && ids.includes('@cf/custom/x') && ids.includes('@cf/baai/bge-m3'));
    assert.equal(models.find(m => m.id === '@cf/baai/bge-m3').kind, 'embedding');
    assert.equal(models.find(m => m.id === '@cf/new/model').source, 'catalog');
    assert.equal(models.find(m => m.id === '@cf/custom/x').source, 'override');
    assert.equal(models.length, Object.keys(BUILTIN_PRICES).length + 2);
});
