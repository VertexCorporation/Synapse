import test from 'node:test';
import assert from 'node:assert/strict';
import {matchCatalogModel, insertCatalogModel, enforceCatalogPolicy} from '../processing/catalog-policy.js';
import {FAMILY_ASSETS, PRODUCER_ASSETS} from '../config/client-assets.js';
import {parseFalModelIdentity} from '../processing/fal.js';
import {buildGroupedDeepgramModels} from '../processing/deepgram.js';
import {buildGroupedCloudflareModels} from '../processing/cloudflare.js';
import {offlineEntries} from '../processing/offline.js';

test('only supplied families/producers authorize an external model', () => {
    for(const [source,id,key] of [['cloudflare','@cf/meta/llama-3.3-70b-instruct','llama'],['cloudflare','@cf/black-forest-labs/flux-1-schnell','flux'],['deepgram','nova-3-general','nova'],['elevenlabs','eleven_v3','elevenlabs'],['fal','fal-ai/veo3','veo'],['fal','fal-ai/google/imagen4','google'],['fal','fal-ai/seedvr/upscale','seedvr'],['fal','fal-ai/veed/fabric','veed']]) {
        const m=matchCatalogModel(source,id);assert.equal(m?.key,key);assert.equal(m.asset,FAMILY_ASSETS[key]||PRODUCER_ASSETS[key]);
    }
});
test('unknown, character and nested vendor impersonations cannot match', () => {
    for(const [source,id] of [['cloudflare','@cf/baai/bge-m3'],['cloudflare','@cf/pipecat/smart-turn'],['deepgram','aura-2-thalia-en'],['deepgram','enhanced-general'],['fal','perceptron/isaac-01/openai/v1/chat/completions'],['fal','fal-ai/mystery/google'],['fal','fal-ai/fluxfake/image'],['fal','fal-ai/animegirl'],['fal','fal-ai/lmnotreal']]) assert.equal(matchCatalogModel(source,id),null,id);
});
test('short producer fallback lm matches only the producer, not arbitrary substring', () => {
    assert.equal(matchCatalogModel('cloudflare','@hf/lmstudio-community/custom')?.key,'lm');
    assert.equal(matchCatalogModel('fal','fal-ai/film-image'),null);
});
test('Fal grouping agrees with allowlist and rejects nested OpenAI wrapper', () => {
    assert.equal(parseFalModelIdentity('perceptron/isaac/openai/v1'),null);
    assert.equal(parseFalModelIdentity('fal-ai/flux-1/schnell').producer,'Black Forest Labs');
    assert.ok(parseFalModelIdentity('fal-ai/seedvr/upscale'));
});
test('identical titles do not erase different model IDs; duplicate ID is idempotent', () => {
    const g={};
    for(const id of ['eleven_v3','eleven_flash_v2','eleven_flash_v2']) insertCatalogModel(g,'ElevenLabs','Voice','Shared',{id,source:'elevenlabs'});
    assert.equal([...offlineEntries(g)].length,2);
});
test('post-merge validation removes unlisted external data and preserves unrelated metadata', () => {
    const untouched={series_description:{en:'Producer'},Models:{hidden:true,Online:{id:'other/model',source:'openrouter',tier:'standard'},Manual:{id:'astronaut',source:'manual',type:'roleplay'}}};
    const g={Other:structuredClone(untouched),Deepgram:{STT:{Bad:{id:'enhanced-general',source:'deepgram'}}}};
    enforceCatalogPolicy(g);assert.deepEqual(g.Other,untouched);assert.equal(g.Deepgram,undefined);
});
test('Deepgram retains Nova and drops Aura/general from API response', async t => {
    t.mock.method(globalThis,'fetch',async()=>Response.json({stt:[{canonical_name:'nova-3-general',name:'general'},{canonical_name:'enhanced-general',name:'general'}],tts:[{canonical_name:'aura-thalia-en',name:'Thalia'}]}));
    const result=await buildGroupedDeepgramModels({},'test',new Set());
    assert.deepEqual([...offlineEntries(result.grouped)].map(e=>e.model.id),['nova-3-general']);
});
test('Cloudflare pagination filters unknown models and keeps distinct versions', async t => {
    t.mock.method(globalThis,'fetch',async url => {
        const page=new URL(url).searchParams.get('page');
        return Response.json({result:page==='1'?[{name:'@cf/meta/llama-3.1-8b-instruct'},{name:'@cf/baai/bge-m3'}]:[{name:'@cf/meta/llama-3.2-8b-instruct'}],result_info:{total_count:51}});
    });
    const result=await buildGroupedCloudflareModels({CF_ACCOUNT_ID:'test',CF_API_TOKEN:'test'},'test',new Set());
    assert.equal([...offlineEntries(result.grouped)].length,2);
});


test('old KV premium tier cannot override new architecture while enrichment survives', async () => {
    const {rehydrateAndMergeProducers,applyFreshOnlineTiers}=await import('../processing/merge.js');
    const fresh={Qwen:{Qwen:{A:{id:'qwen/a',source:'openrouter',tier:'standard'}}}};
    const current={Qwen:{Qwen:{A:{id:'qwen/a',source:'openrouter',tier:'premium',description:{tr:'Korunacak'}}}}};
    const final=rehydrateAndMergeProducers(current,structuredClone(fresh));
    applyFreshOnlineTiers(final,fresh);
    assert.equal(final.Qwen.Qwen.A.tier,'standard');assert.equal(final.Qwen.Qwen.A.description.tr,'Korunacak');
});

test('legacy premium label is retired even when Curator preserved an old online ID', async () => {
    const {applyFreshOnlineTiers}=await import('../processing/merge.js');
    const g={Qwen:{Qwen:{A:{id:'qwen/old-alias',source:'openrouter',tier:'premium'}}}};
    applyFreshOnlineTiers(g,{},'fallback');assert.equal(g.Qwen.Qwen.A.tier,'fallback');
});
