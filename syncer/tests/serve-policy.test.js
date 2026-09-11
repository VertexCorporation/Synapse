import test from 'node:test';
import assert from 'node:assert/strict';
import {serveModelsJson} from '../core/serve.js';
import {offlineEntries} from '../processing/offline.js';

test('serving old KV applies policy and offline grouping and bypasses obsolete edge cache',async t=>{
    const data={producers:{
        SDAIA:{Allam:{A:{id:'sdaia/allam:free',source:'openrouter'}}},
        Deepgram:{STT:{A:{id:'nova-3-general',source:'deepgram'}}},
        Publisher:{'Next 1B':{Default:{id:'next-1b',type:'offline',source:'manual',size:900}},
            'Next 4B':{Default:{id:'next-4b',type:'offline',source:'manual',size:3000}}},
    },fallback:{SDAIA:{Allam:{A:{id:'sdaia/allam:free',source:'openrouter'}}}}};
    const savedCaches=globalThis.caches;
    globalThis.caches={default:{async match(){return Response.json(data);},async put(){}}};
    t.after(()=>{if(savedCaches===undefined)delete globalThis.caches;else globalThis.caches=savedCaches;});
    const kv={async get(key){return key==='list'?JSON.stringify(data):key==='version'?'test-version':null;}};
    const pending=[];
    const result=await serveModelsJson({MODELS_JSON:kv},new Request('https://cortexishere.com/models'),{waitUntil(p){pending.push(p);}});
    await Promise.all(pending);
    const body=await result.json();
    assert.equal(body.producers.SDAIA,undefined);
    assert.deepEqual(body.fallback,{});
    assert.deepEqual(Object.keys(body.producers.Deepgram),['Nova']);
    assert.equal([...offlineEntries(body.producers)].filter(e=>e.s==='Next').length,2);
    assert.equal(result.headers.get('X-Catalog-Policy'),'5');
});
