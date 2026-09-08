import { insertCatalogModel } from './catalog-policy.js';
import { offlineEntries } from './offline.js';

const OPERATIONS = new Set([
    'edit', 'edit-video', 'video-edit', 'multi', 'reference', 'remix', 'transition',
    'inpainting', 'inpaint', 'outpainting', 'outpaint', 'extend', 'extend-video',
    'audio-inpainting', 'audio-outpainting', 'reframe', 'replace', 'erase', 'effects',
    'motion-control', 'elements', 'redux', 'depth', 'canny', 'fill',
]);
export function falBaseId(id) {
    // These two published namespaces serve the same FLUX.1 editions; keep their routes as alternatives.
    const parts = id.replace(/^fal-ai\/flux-1\//, 'fal-ai/flux/').split('/');
    return parts.filter((part, index) => index < 2 || (!OPERATIONS.has(part) && !/^(?:text|image|video|audio|speech|reference|first-last-frame|keyframes)-to-(?:image|video|audio|speech|text)$/.test(part))).join('/');
}

export function consolidateFalModels(grouped, blacklist = new Set()) {
    const buckets = new Map();
    const blockedBases = new Set([...blacklist].filter(id => typeof id === 'string' && id.includes('/')).map(falBaseId));
    for (const entry of offlineEntries(grouped)) {
        const baseId = falBaseId(entry.model.id);
        if (blockedBases.has(baseId)) continue;
        if (!buckets.has(baseId)) buckets.set(baseId, []);
        buckets.get(baseId).push(entry);
    }
    const result = {};
    for (const [baseId, entries] of buckets) {
        entries.sort((a,b) => {
            const rank = e => (e.model.id === baseId ? 0 : e.model.falEndpoint.category?.startsWith('text-to-') ? 1 : 2);
            return rank(a)-rank(b) || a.model.id.length-b.model.id.length || a.model.id.localeCompare(b.model.id);
        });
        const primary = entries[0];
        const endpoints = entries.map(e => ({ id: e.model.id, ...e.model.falEndpoint })).sort((a,b)=>a.id.localeCompare(b.id));
        const model = { ...primary.model, fal: { version: 1, baseId, defaultEndpoint: primary.model.id, endpoints } };
        delete model.falEndpoint;
        model.modalities = { image: false, video: false, audio: false, file: false };
        model.outputs = { image: false, video: false, audio: false };
        for (const endpoint of endpoints) {
            const category = endpoint.category || '';
            const [input, output] = category.split('-to-');
            if (input in model.modalities) model.modalities[input] = true;
            if (output in model.outputs) model.outputs[output] = true;
            if (output === 'speech') model.outputs.audio = true;
        }
        // Display identity comes from the model path, so task-specific API titles cannot leak into variants.
        const title = baseId.split('/').slice(1).join(' ').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        insertCatalogModel(result, primary.p, primary.s, title, model);
    }
    return result;
}

export function applyFreshFalRouting(final, fresh) {
    const byId = new Map([...offlineEntries(fresh)].filter(e=>e.model.source==='fal').map(e=>[e.model.id,e.model]));
    for (const {model} of offlineEntries(final)) {
        if (model.source !== 'fal') continue;
        const next = byId.get(model.id);
        if (!next) continue;
        for (const key of ['fal','modalities','outputs']) model[key] = next[key];
    }
}
