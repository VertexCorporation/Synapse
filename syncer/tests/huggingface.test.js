import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroupedHuggingFaceModels, repositoryVariants, eligibleRepository, applyFreshHuggingFaceMetadata } from '../processing/huggingface-discovery.js';
import { offlineGrouping, offlineEntries, migrateOfflineEnrichment, mergeOfflineModels } from '../processing/offline.js';
import { processManualModels } from '../processing/manual.js';
import { rehydrateAndMergeProducers } from '../processing/merge.js';
import { refreshHuggingFaceModels } from '../processing/huggingface.js';
import { buildGroupedOnlineModels } from '../processing/online.js';
import { saveManualModel } from '../../curator/utils/kv.js';
import { syncModels } from '../core/sync.js';

const file = (rfilename, size = 104857600) => ({ rfilename, size });
const repo = (overrides = {}) => ({ id: 'bartowski/Llama-3.1-8B-Instruct-GGUF', likes: 100, downloads: 60000, pipeline_tag: 'text-generation', siblings: [file('Llama-3.1-8B-Instruct-Q4_K_M.gguf'), file('Llama-3.1-8B-Instruct-Q8_0.gguf')], ...overrides });
const entries = tree => [...offlineEntries(tree)];
const response = body => Response.json(body);
const mockHub = (t, list = [repo()], detail = repo()) => t.mock.method(globalThis, 'fetch', async url => response(new URL(url).pathname === '/api/models' ? list : detail));
function kvStore(values = {}) {
    const map = new Map(Object.entries(values));
    return { map, async get(k, type) { const v = map.get(k) ?? null; return type === 'json' && v !== null ? JSON.parse(v) : v; }, async put(k, v) { map.set(k, v); }, async delete(k) { map.delete(k); }, async list() { return { list_complete: true, keys: [...map.keys()].filter(k => k.startsWith('model:')).map(name => ({ name })) }; } };
}

test('family/version groups sizes and quants without Default', () => {
    for (const [id, series, variant] of [['gemma-3-12b-it', 'Gemma 3', '12B Instruct'], ['gemma-7b-it', 'Gemma', '7B Instruct'], ['Qwen3-0.6B', 'Qwen 3', '0.6B'], ['llama-3.1-70b-instruct', 'Llama 3.1', '70B Instruct']]) {
        const got = offlineGrouping({ id, url: `https://huggingface.co/a/b/resolve/main/${id}-Q4_K_M.gguf` });
        assert.equal(got.series, series); assert.equal(got.variant, `${variant} (Q4_K_M)`);
    }
});

test('one variant per exact standalone quant; ignore auxiliary files and shards', () => {
    const grouped = repositoryVariants(repo({ siblings: [...repo().siblings, file('MTP/mtp-Q4_K_M.gguf'), file('mmproj-F16.gguf'), file('Q4_K_M-00001-of-00002.gguf'), file('README.md'), file('no-size-Q5_0.gguf', undefined)].map(f => f.rfilename.startsWith('no-size') ? { rfilename: f.rfilename } : f) }));
    const values = entries(grouped);
    assert.equal(values.length, 2); assert.equal(new Set(values.map(e => e.model.id)).size, 2);
    assert.deepEqual(values.map(e => e.model.huggingface.quant), ['Q4_K_M', 'Q8_0']);
    assert.ok(values.every(e => e.model.size === 100 && e.model.ram === 2100 && e.model.tier === 'free'));
});

test('same quant in distinct recipes is not overwritten', () => {
    const tree = repositoryVariants(repo({ siblings: [file('normal-Q4_K_M.gguf'), file('alternative-Q4_K_M.gguf')] }));
    assert.equal(entries(tree).length, 2);
});

test('old popularity rules remain; gated/private/nontext repositories excluded', () => {
    assert.ok(eligibleRepository(repo()));
    for (const change of [{ downloads: 999 }, { likes: 49, downloads: 49999 }, { gated: 'auto' }, { private: true }, { pipeline_tag: 'text-to-image' }]) assert.equal(eligibleRepository(repo(change)), false);
});

test('dynamic list changes yield new models and obey repository/file blacklist', async t => {
    mockHub(t);
    const all = await buildGroupedHuggingFaceModels({}, 'test');
    assert.equal(entries(all.grouped).length, 2);
    const id = entries(all.grouped)[0].model.id;
    assert.equal(entries((await buildGroupedHuggingFaceModels({}, 'test', new Set([id]))).grouped).length, 1);
    assert.equal(entries((await buildGroupedHuggingFaceModels({}, 'test', new Set([repo().id]))).grouped).length, 0);
    globalThis.fetch.mock.restore();
    const next = repo({ id: 'bartowski/Llama-3.1-70B-Instruct-GGUF' });
    mockHub(t, [next], next);
    const updated = await buildGroupedHuggingFaceModels({}, 'test', new Set(), all.grouped);
    assert.ok(entries(updated.grouped).every(e => e.model.id.startsWith(next.id)));
});

test('list outage/invalid/empty payload retain existing HF, respecting blacklist', async t => {
    const current = repositoryVariants(repo());
    for (const body of [null, {}, []]) {
        mockHub(t, body);
        assert.deepEqual((await buildGroupedHuggingFaceModels({}, 'test', new Set(), current)).grouped, current);
        globalThis.fetch.mock.restore();
    }
    t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
    assert.equal(entries((await buildGroupedHuggingFaceModels({}, 'test', new Set([repo().id]), current)).grouped).length, 0);
});

test('one repository outage retains only its existing variants', async t => {
    const current = repositoryVariants(repo());
    mockHub(t, [repo()], {});
    assert.deepEqual((await buildGroupedHuggingFaceModels({}, 'test', new Set(), current)).grouped, current);
});

test('fresh sizes win after rehydrate while translations and hidden survive', () => {
    const fresh = repositoryVariants(repo());
    const current = structuredClone(fresh);
    const model = entries(current)[0].model; model.size = 9; model.description = { tr: 'Korunacak' }; model.hidden = true;
    const merged = rehydrateAndMergeProducers(current, fresh);
    applyFreshHuggingFaceMetadata(merged, repositoryVariants(repo()));
    assert.equal(entries(merged)[0].model.size, 100);
    assert.equal(entries(merged)[0].model.description.tr, 'Korunacak'); assert.equal(entries(merged)[0].model.hidden, true);
});

test('manual regrouping retains enrichment and series visibility', () => {
    const m = { id: 'gemma-3-12b-it', source: 'manual', type: 'offline', details: { tr: { title: 'Türkçe' } } };
    const current = { Google: { [m.id]: { Default: m, hidden: true } } };
    const fresh = { Google: { 'Gemma 3': { '12B Instruct (Q4_0)': { ...m, details: {} } } } };
    migrateOfflineEnrichment(current, fresh);
    const merged = rehydrateAndMergeProducers(current, fresh);
    assert.equal(entries(merged).length, 1); assert.equal(entries(merged)[0].model.details.tr.title, 'Türkçe');
    assert.equal(merged.Google['Gemma 3'].hidden, true);
});

test('offline merge preserves colliding online and hybrid records exactly', () => {
    const hf = repositoryVariants(repo()); const e = entries(hf)[0];
    const onlineModel = { id: 'meta-llama/online', source: 'openrouter', tier: 'standard', url: 'https://huggingface.co/attached', description: { tr: 'aynı' } };
    const online = { [e.p]: { [e.s]: { [e.v]: onlineModel } } };
    const merged = mergeOfflineModels(online, hf, {});
    assert.deepEqual(merged[e.p][e.s][e.v], onlineModel); assert.equal(entries(merged).length, 3);
});

test('manual KV pagination and roleplay Default preserved', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    const models = [{ id: 'astronaut', type: 'roleplay', details: { en: { title: 'Astronaut' } } }, { id: 'gemma-3-12b-it', type: 'offline', producer: 'Google', url: 'https://huggingface.co/a/b/resolve/main/Gemma-Q4_0.gguf', details: { en: { title: 'Gemma 3 12B' } } }];
    const kv = { async list({ cursor }) { return { keys: [{ name: cursor ? '1' : '0' }], list_complete: !!cursor, cursor: 'next' }; }, async get(k) { return models[Number(k)]; } };
    const grouped = await processManualModels(kv, 'test');
    assert.equal(grouped.Vertex.astronaut.Default.type, 'roleplay'); assert.equal(entries(grouped).length, 2);
});

test('Curator saves and edits grouped offline without duplicate and keeps roleplay shape', async () => {
    const m = { id: 'gemma-3-12b-it', type: 'offline', source: 'manual', producer: 'Google', details: { en: { title: 'Gemma' }, tr: { title: 'Korunacak' } } };
    const kv = kvStore({ list: JSON.stringify({ producers: { Google: { [m.id]: { Default: m } } } }) });
    await saveManualModel(kv, null, m, 'test', true);
    await saveManualModel(kv, null, { ...m, size: 100 }, 'test', true);
    assert.equal(entries(JSON.parse(kv.map.get('list')).producers).length, 1);
    await saveManualModel(kv, null, { id: 'astronaut', producer: 'Vertex', type: 'roleplay' }, 'test');
    assert.equal(JSON.parse(kv.map.get('list')).producers.Vertex.astronaut.Default.type, 'roleplay');
});

test('incomplete shards cannot overwrite existing manual size with partial total', async t => {
    t.mock.method(globalThis, 'fetch', async () => response({ siblings: [file('Q4_0-00001-of-00002.gguf')] }));
    const tree = { A: { B: { C: { id: 'manual', source: 'manual', size: 300, url: 'https://huggingface.co/a/b/resolve/main/Q4_0-00001-of-00002.gguf' } } } };
    await refreshHuggingFaceModels(tree, {}, {}, 'test'); assert.equal(tree.A.B.C.size, 300);
});

const onlinePayload = { data: [
    { id: 'qwen/qwen3-8b', name: 'Qwen: Qwen3 8B', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'qwen/qwen3-8b:free', name: 'Qwen: Qwen3 8B (free)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
] };
test('new architecture online tiers remain standard/fallback, never premium', async t => {
    t.mock.method(globalThis, 'fetch', async () => response(onlinePayload));
    const result = await buildGroupedOnlineModels({ OPENROUTER_KEY: 'test' }, 'test', new Set());
    assert.equal(entries(result.grouped)[0].model.tier, 'standard');
    assert.equal(entries(result.fallbackGrouped)[0].model.tier, 'fallback');
});

test('complete scheduled sync writes dynamic offline alongside unchanged online/fallback', async t => {
    t.mock.method(globalThis, 'fetch', async url => {
        const u = new URL(url);
        if (u.hostname === 'openrouter.ai') return response(onlinePayload);
        if (u.hostname === 'huggingface.co') return response(u.pathname === '/api/models' ? [repo()] : repo());
        return response({ models: [] });
    });
    const originalCaches = globalThis.caches;
    globalThis.caches = { default: { async delete() { return false; } } };
    t.after(() => { if (originalCaches === undefined) delete globalThis.caches; else globalThis.caches = originalCaches; });
    const kv = kvStore(); const pending = []; const ctx = { waitUntil(p) { pending.push(p); } };
    await syncModels({ MODELS_JSON: kv, OPENROUTER_KEY: 'test' }, ctx); await Promise.all(pending);
    const data = JSON.parse(kv.map.get('list'));
    assert.equal(entries(data.producers).filter(e => e.model.source === 'huggingface').length, 2);
    assert.equal(entries(data.producers).find(e => e.model.source === 'openrouter').model.tier, 'standard');
    assert.equal(entries(data.fallback)[0].model.tier, 'fallback');
});
