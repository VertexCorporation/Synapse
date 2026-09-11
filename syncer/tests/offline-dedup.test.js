import test from 'node:test';
import assert from 'node:assert/strict';
import {deduplicateOfflineModels, offlineEntries, regroupOfflineModels} from '../processing/offline.js';
const model=(id,title,quant,source='huggingface')=>({id,type:'offline',source,url:`https://huggingface.co/p/repo/resolve/main/model-${quant}.gguf`,huggingface:{quant},details:{en:{title},tr:{description:'Korunacak'}},size:1000,ram:3000});
test('quants and duplicate recipes collapse deterministically, sizes and versions survive',()=>{
 const tree={Qwen:{Qwen:{a:model('q8','DeepSeek R1 0528 Qwen3 8B (Q8_0)','Q8_0'),b:model('q4','DeepSeek R1 0528 Qwen3 8B (Q4_K_M)','Q4_K_M'),c:model('q4-other','DeepSeek R1 0528 Qwen3 8B (Q4_K_M)','Q4_K_M'),d:model('4b','Qwen3 4B (Q4_K_M)','Q4_K_M'),e:model('v2','Qwen2 4B (Q4_K_M)','Q4_K_M')}}};
 deduplicateOfflineModels(tree);
 assert.deepEqual([...offlineEntries(tree)].map(e=>e.model.id),['q4','4b','v2']);
 assert.equal(tree.Qwen.Qwen.b.details.tr.description,'Korunacak');
 const snapshot=structuredClone(tree);deduplicateOfflineModels(tree);assert.deepEqual(tree,snapshot);
});
test('manual choice wins and online entries are untouched',()=>{
 const manual=model('manual','GLM 4.7 Flash','Q4_0','manual');const online={id:'online',source:'openrouter',type:'online'};
 const tree={Z:{GLM:{manual,hf:model('hf','GLM 4.7 Flash (Q4_K_M)','Q4_K_M'),online},series_description:{en:'Producer'}}};
 regroupOfflineModels(tree);deduplicateOfflineModels(tree);
 assert.ok([...offlineEntries(tree)].some(e=>e.model===manual));
 assert.ok([...offlineEntries(tree)].some(e=>e.model===online));
 assert.equal([...offlineEntries(tree)].length,2);
});
