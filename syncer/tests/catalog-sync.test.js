import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { syncModels } from '../core/sync.js';
import { serveModelsJson } from '../core/serve.js';
import { validateCortexModel } from '../processing/normalize/schema.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = name => JSON.parse(fs.readFileSync(join(fixtures, `${name}.json`), 'utf8'));

// ---------------------------------------------------------------- test harness
function makeKV() {
    const store = new Map();
    return {
        store,
        async get(key, type) {
            if (!store.has(key)) return null;
            const value = store.get(key);
            return type === 'json' ? JSON.parse(value) : value;
        },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
        async list({ prefix = '' } = {}) {
            const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
            return { keys, list_complete: true };
        },
    };
}

function fixturePayloads() {
    const cf = load('cloudflare');
    return {
        'openrouter.ai': () => load('openrouter'),
        'api.groq.com': () => load('groq'),
        'api.cloudflare.com': () => ({ result: cf.result, result_info: { total_count: cf.result.length } }),
        'api.elevenlabs.io': () => load('elevenlabs'),
        'api.deepgram.com': () => load('deepgram'),
        'api.fal.ai': () => ({ models: load('fal').models, has_more: false }),
    };
}

/** Mock fetch: override patterns win, then fixture payloads, then `{}` (HF discovery degrades). */
function mockFetch(overrides = {}, payloads = fixturePayloads()) {
    return async url => {
        const u = String(url);
        for (const [pattern, payload] of Object.entries(overrides)) {
            if (u.includes(pattern)) return typeof payload === 'function' ? payload(u) : payload;
        }
        for (const [pattern, payload] of Object.entries(payloads)) {
            if (u.includes(pattern)) return Response.json(payload());
        }
        return Response.json({});
    };
}

const ENV = {
    OPENROUTER_KEY: 'test', GROQ_API_KEY: 'test',
    CLOUDFLARE_ACCOUNT_ID: 'test', CLOUDFLARE_API_TOKEN: 'test',
    ELEVENLABS_KEY: 'test', DEEPGRAM_KEY: 'test',
};

async function runSync(env, kv, locks) {
    const pending = [];
    const savedCaches = globalThis.caches;
    globalThis.caches = { default: { async match() { return undefined; }, async put() {}, async delete() { return false; } } };
    try {
        await syncModels({ ...env, MODELS_JSON: kv }, { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } });
    } finally {
        if (savedCaches === undefined) delete globalThis.caches; else globalThis.caches = savedCaches;
    }
    await Promise.all(pending);
    return kv.store.has('list') ? JSON.parse(kv.store.get('list')) : null;
}

test('sync writes an additive validated catalog while preserving the producers tree', async t => {
    t.mock.method(globalThis, 'fetch', mockFetch());
    const kv = makeKV();
    const doc = await runSync(ENV, kv, makeKV());

    assert.ok(doc, 'list document must be written');
    // Company -> Series -> Model tree intact.
    assert.ok(doc.producers?.OpenAI?.ChatGPT, 'tree should keep OpenAI/ChatGPT');
    assert.ok(doc.producers?.['Moonshot AI']?.Kimi, 'tree should keep Moonshot AI/Kimi');
    assert.ok(doc.producers?.Google, 'tree should keep Google');
    // Catalog: array of valid records.
    assert.ok(Array.isArray(doc.catalog) && doc.catalog.length > 20, 'catalog should be substantial');
    for (const record of doc.catalog) {
        const { ok, errors } = validateCortexModel(record);
        assert.ok(ok, `invalid record ${record.id}: ${errors.join('; ')}`);
    }
    // Bookkeeping initialized.
    assert.ok(doc.catalog.every(r => r.firstSeenAt && r.lastSeenAt));

    // Dedup became routing: gpt-oss-120b is served by groq + cloudflare + openrouter.
    const gptOss = doc.catalog.filter(r => r.canonicalKey === 'gpt-oss-120b');
    assert.equal(new Set(gptOss.map(r => r.source)).size, 3, 'all three routes kept in catalog');
    for (const record of gptOss) {
        assert.equal(record.routes.length, 3);
        assert.equal(record.routes.find(r => r.preferred).source, 'groq'); // SOURCE_PRIORITY
        assert.deepEqual(record.routes.map(r => r.id).sort(), ['@cf/openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b'].sort());
    }
    // ...while the tree keeps only the winner (groq, priority 6).
    const treeIds = [];
    for (const series of Object.values(doc.producers.OpenAI || {})) {
        for (const model of Object.values(series || {})) if (model?.id?.includes('gpt-oss-120b')) treeIds.push(model.id);
    }
    assert.equal(treeIds.length, 1, `tree should keep exactly one gpt-oss-120b entry, got ${JSON.stringify(treeIds)}`);
    assert.equal(treeIds[0], 'openai/gpt-oss-120b');

    // Provider health persisted.
    const health = JSON.parse(kv.store.get('provider_health'));
    assert.equal(health.providers.groq, true);
    assert.equal(health.providers.cloudflare, true);
    assert.equal(health.providers.openrouter, true);
    // Hash + version written.
    assert.ok(kv.store.get('hash'));
    assert.ok(kv.store.get('version'));
});

test('a failed provider run cannot prune its catalog records', async t => {
    t.mock.method(globalThis, 'fetch', mockFetch());
    const kv = makeKV();
    await runSync(ENV, kv, makeKV());
    const doc1 = JSON.parse(kv.store.get('list'));
    const groqBefore = doc1.catalog.filter(r => r.source === 'groq');
    assert.ok(groqBefore.length > 0, 'run 1 should have groq records');

    // Run 2: Groq returns HTTP 500. The processor catches it and reports ok:false.
    t.mock.method(globalThis, 'fetch', mockFetch({ 'api.groq.com': () => new Response('boom', { status: 500 }) }));
    await runSync(ENV, kv, makeKV());
    const health = JSON.parse(kv.store.get('provider_health'));
    assert.equal(health.providers.groq, false, 'health must flag the failed provider');
    const doc2 = JSON.parse(kv.store.get('list'));
    const groqAfter = doc2.catalog.filter(r => r.source === 'groq');
    assert.equal(groqAfter.length, groqBefore.length, 'failed provider must not prune its catalog records');
    assert.ok(groqAfter.every(r => (r.absentStreak || 0) === 0), 'absence streak must not tick during failure');

    // Run 3: still failing — records survive again.
    await runSync(ENV, kv, makeKV());
    const doc3 = JSON.parse(kv.store.get('list'));
    assert.equal(doc3.catalog.filter(r => r.source === 'groq').length, groqBefore.length);
});

test('absentStreak: a removed model survives two healthy absences and is pruned on the third', async t => {
    const groqWithoutWhisper = () => {
        const payload = load('groq');
        return { ...payload, data: payload.data.filter(m => !/whisper/.test(m.id)) };
    };
    t.mock.method(globalThis, 'fetch', mockFetch());
    const kv = makeKV();
    const doc1 = await runSync(ENV, kv, makeKV());
    assert.ok(doc1.catalog.some(r => r.id === 'whisper-large-v3'));

    // Run 2: healthy run without whisper -> grace 1.
    t.mock.method(globalThis, 'fetch', mockFetch({ 'api.groq.com': () => Response.json(groqWithoutWhisper()) }));
    const doc2 = await runSync(ENV, kv, makeKV());
    const w2 = doc2.catalog.find(r => r.id === 'whisper-large-v3');
    assert.ok(w2, 'first healthy absence must be kept in grace');
    assert.equal(w2.absentStreak, 1);

    // Run 3: grace 2.
    const doc3 = await runSync(ENV, kv, makeKV());
    const w3 = doc3.catalog.find(r => r.id === 'whisper-large-v3');
    assert.ok(w3 && w3.absentStreak === 2, 'second healthy absence must be kept in grace');

    // Run 4: pruned.
    const doc4 = await runSync(ENV, kv, makeKV());
    assert.ok(!doc4.catalog.some(r => r.id === 'whisper-large-v3'), 'third healthy absence must prune');
});

test('fresh provider facts beat stale KV state while curator enrichment survives', async t => {
    t.mock.method(globalThis, 'fetch', mockFetch());
    const kv = makeKV();
    await runSync(ENV, kv, makeKV());

    // Simulate stale KV + curator enrichment on the cloudflare gpt-oss record.
    const doc = JSON.parse(kv.store.get('list'));
    const idx = doc.catalog.findIndex(r => r.id === '@cf/openai/gpt-oss-120b');
    assert.ok(idx >= 0);
    doc.catalog[idx].limits.contextTokens = 555; // stale KV fact
    doc.catalog[idx].tier = 'premium';           // curator override
    doc.catalog[idx].curator = { note: 'featured' };
    kv.store.set('list', JSON.stringify(doc));

    t.mock.method(globalThis, 'fetch', mockFetch());
    const doc2 = await runSync(ENV, kv, makeKV());
    const record = doc2.catalog.find(r => r.id === '@cf/openai/gpt-oss-120b');
    assert.equal(record.limits.contextTokens, 128000, 'fresh provider fact must beat stale KV');
    assert.equal(record.tier, 'premium', 'curator premium tier must survive');
    assert.deepEqual(record.curator, { note: 'featured' }, 'curator notes must survive');
    assert.equal(record.firstSeenAt, doc.catalog[idx].firstSeenAt, 'firstSeenAt is stable');
});

test('OpenRouter 0-model sanity check aborts the run and writes nothing', async t => {
    t.mock.method(globalThis, 'fetch', mockFetch());
    const kv = makeKV();
    await runSync(ENV, kv, makeKV());
    const before = kv.store.get('list');
    const hashBefore = kv.store.get('hash');

    t.mock.method(globalThis, 'fetch', mockFetch({ 'openrouter.ai': () => Response.json({ data: [] }) }));
    const doc = await runSync(ENV, kv, makeKV());
    assert.deepEqual(doc, JSON.parse(before), 'document unchanged');
    assert.equal(kv.store.get('hash'), hashBefore, 'hash unchanged');
});

test('serve filters the catalog and producers trees by the blacklist', async t => {
    const data = {
        producers: { Deepgram: { Nova: { General: { id: 'nova-3-general', source: 'deepgram' } } } },
        catalog: [
            { id: 'nova-3-general', source: 'deepgram', canonicalKey: 'nova-3-general', category: 'stt', metadataQuality: {} },
            { id: 'whisper-large-v3', source: 'groq', canonicalKey: 'whisper-large-v3', category: 'stt', metadataQuality: {} },
        ],
    };
    const kv = makeKV();
    kv.store.set('list', JSON.stringify(data));
    kv.store.set('model_blacklist', JSON.stringify(['whisper-large-v3']));

    const savedCaches = globalThis.caches;
    globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
    t.after(() => { if (savedCaches === undefined) delete globalThis.caches; else globalThis.caches = savedCaches; });
    const pending = [];
    const response = await serveModelsJson({ MODELS_JSON: kv }, new Request('https://cortexishere.com/models'), { waitUntil(p) { pending.push(p); } });
    await Promise.all(pending);
    const body = await response.json();
    assert.deepEqual(body.catalog.map(r => r.id), ['nova-3-general'], 'blacklisted record must be filtered from catalog');
    assert.ok(body.producers.Deepgram.Nova.General, 'non-blacklisted tree entries survive');
});

