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
    for (const [id, series, variant] of [['gemma-3-12b-it', 'Gemma', 'gemma 3 12B Instruct'], ['gemma-7b-it', 'Gemma', 'gemma 7B Instruct'], ['Qwen3-0.6B', 'Qwen', 'Qwen3 0.6B'], ['llama-3.1-70b-instruct', 'Llama', 'llama 3.1 70B Instruct']]) {
        const got = offlineGrouping({ id, url: `https://huggingface.co/a/b/resolve/main/${id}-Q4_K_M.gguf` });
        assert.equal(got.series, series); assert.equal(got.variant, `${variant} (Q4_K_M)`);
    }
});

test('every supported offline family groups generations and preserves full variants', async () => {
    const { OFFLINE_FAMILIES, regroupOfflineModels } = await import('../processing/offline.js');
    const examples = ['Nemotron', 'TinyLlama', 'Gemma', 'Llama', 'Qwen', 'Next',
        'DeepSeek', 'Mixtral', 'Mistral', 'Phi', 'GPT-OSS', 'Command', 'Aya',
        'SuperNova', 'Jan', 'Zeta', 'GLM', 'Kimi', 'Granite', 'Ministral',
        'Magistral', 'Devstral', 'Codestral', 'Pixtral', 'Hermes', 'LFM'];
    const tree = { Legacy: {} };
    for (const name of examples) {
        for (const generation of [2, 3]) {
            const label = `${name} ${generation} 7B Chat`;
            tree.Legacy[label] = { Default: { id: label.replaceAll(' ', '-'),
                type: 'offline', source: 'manual', details: { en: { title: label } } } };
        }
    }
    regroupOfflineModels(tree);
    const values = entries(tree);
    assert.deepEqual(new Set(values.map(e => e.s)), OFFLINE_FAMILIES);
    for (const family of OFFLINE_FAMILIES) {
        const variants = values.filter(e => e.s === family);
        assert.equal(variants.length, 2);
        assert.ok(variants.every(e => e.v.endsWith('7B Chat')));
    }
    assert.ok(tree.Meta.Llama['Llama 2 7B Chat']);
    assert.ok(tree.Meta.Llama['Llama 3 7B Chat']);
    assert.equal(offlineGrouping({ id: 'jannano128k' }).series, 'Jan');
    assert.equal(offlineGrouping({ id: 'jan-nano' }).series, 'Jan');
    const snapshot = structuredClone(tree);
    regroupOfflineModels(tree);
    assert.deepEqual(tree, snapshot);
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
    assert.equal(entries(data.producers).filter(e => e.model.source === 'huggingface').length, 1);
    assert.equal(entries(data.producers).find(e => e.model.source === 'openrouter').model.tier, 'standard');
    assert.equal(entries(data.fallback)[0].model.tier, 'fallback');
});

test('Next 1B and Next 4B share one family without losing sizes, URLs or quants', async()=>{
    const {regroupOfflineModels}=await import('../processing/offline.js');
    const first=repositoryVariants(repo({id:'publisher/Next-1B-GGUF',siblings:[file('Next-1B-Q4_K_M.gguf',1048576000)]}));
    const second=repositoryVariants(repo({id:'publisher/Next-4B-GGUF',siblings:[file('Next-4B-Q8_0.gguf',4194304000)]}));
    const grouped=mergeOfflineModels({},first,second);
    regroupOfflineModels(grouped);
    const values=entries(grouped);
    assert.deepEqual([...new Set(values.map(e=>e.s))],['Next']);
    assert.equal(values.length,2);
    assert.ok(values.some(e=>e.v==='Next 1B (Q4_K_M)'));
    assert.ok(values.some(e=>e.v==='Next 4B (Q8_0)'));
    assert.equal(new Set(values.map(e=>e.model.url)).size,2);
    const original=structuredClone(grouped);regroupOfflineModels(grouped);assert.deepEqual(grouped,original);
});

// --- Chat-template architecture detection (canonical metadata) -------------

test('inferChatFormat routes every offline family to its correct template', async () => {
    const { inferChatFormat } = await import('../processing/huggingface-chat.js');
    const cases = [
        ['Qwen/Qwen3-0.6B-GGUF', 'chatml'],
        ['unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', 'chatml'],
        ['bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'llama3'],
        ['TheBloke/Llama-2-7B-Chat-GGUF', 'llama2'],
        ['TheBloke/Mistral-7B-Instruct-v0.1-GGUF', 'llama2'],
        ['unsloth/GLM-4.7-Flash-GGUF', 'phi-3_glm'],
        ['microsoft/Phi-3-mini-4k-instruct-gguf', 'phi-3_glm'],
        ['microsoft/phi-4-gguf', 'phi-3_glm'],
        // ChatML families must be matched before the generic Mistral rule.
        ['NousResearch/Hermes-2-Pro-Mistral-7B-GGUF', 'chatml'],
        ['google/gemma-2-9b-it-GGUF', 'gemma'],
    ];
    for (const [id, expected] of cases) {
        assert.equal(inferChatFormat(id, []).template, expected, id);
    }
    // The [INST] template carries the Llama 2 conversation shape.
    const llama2 = inferChatFormat('TheBloke/Llama-2-7B-Chat-GGUF', []).tokens;
    assert.equal(llama2.system_start, '<<SYS>>');
    assert.equal(llama2.user_start, '[INST]');
    assert.equal(llama2.user_end, '[/INST]');
    assert.ok(llama2.stop_generation.includes('\x3c/s\x3e'));
    // Unknown ids fall back to ChatML, never raw completion.
    assert.equal(inferChatFormat('totally-unknown-model', []).template, 'chatml');
});

test('embedding models are never published as offline chat models', () => {
    assert.equal(eligibleRepository(repo({ id: 'Qwen/Qwen3-Embedding-0.6B-GGUF' })), false);
    assert.ok(eligibleRepository(repo({ id: 'Qwen/Qwen3-0.6B-GGUF' })));
});

test('chatFormat refresh reaches already-published HF entries, never manual curation', () => {
    const fresh = repositoryVariants(repo({ id: 'TheBloke/Llama-2-7B-Chat-GGUF', siblings: [file('llama-2-7b-chat.Q4_K_M.gguf')] }));
    const stale = structuredClone(fresh);
    // A frozen, wrongly inferred format (the old default) on a published entry.
    entries(stale)[0].model.chatFormat = { template: 'chatml', tokens: {} };
    const manual = { id: 'qwen3-06b', source: 'manual', type: 'offline', details: { en: { title: 'Qwen3 0.6B' } } };
    const current = mergeOfflineModels(stale, {}, { Qwen: { Qwen: { 'Qwen3 0.6B': manual } } });
    applyFreshHuggingFaceMetadata(current, fresh);
    const byId = new Map(entries(current).map(e => [e.model.id, e.model]));
    assert.equal(byId.get('TheBloke/Llama-2-7B-Chat-GGUF:llama-2-7b-chat.Q4_K_M.gguf').chatFormat.template, 'llama2',
        'a corrected inference must overwrite the stale published chatFormat');
    assert.equal(byId.get('qwen3-06b').chatFormat, undefined,
        'manual (curated) entries are never rewritten by the HF refresh');
});

test('manual offline models without chatFormat get the inferred family template', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    const models = [
        { id: 'gemma-3-12b-it', type: 'offline', producer: 'Google', url: 'https://huggingface.co/a/b/resolve/main/Gemma-Q4_0.gguf', details: { en: { title: 'Gemma 3 12B' } } },
        { id: 'qwen3-06b', type: 'offline', producer: 'Qwen', chatFormat: { template: 'qwen', tokens: { stop_generation: ['\x3c|im_end|\x3e'] } }, details: { en: { title: 'Qwen3 0.6B' } } },
    ];
    const kv = { async list() { return { list_complete: true, keys: models.map((_, i) => ({ name: `model:${i}` })) }; }, async get(k) { return models[Number(k.split(':')[1])]; } };
    const grouped = await processManualModels(kv, 'test');
    const byId = new Map(entries(grouped).map(e => [e.model.id, e.model]));
    assert.equal(byId.get('gemma-3-12b-it').chatFormat.template, 'gemma',
        'a missing chatFormat is filled from the family inference');
    assert.equal(byId.get('qwen3-06b').chatFormat.template, 'qwen',
        'a curated chatFormat is never overwritten by inference');
    globalThis.fetch.mock.restore();
});
