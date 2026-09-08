// Restores discovery from deployed version 9f2e9f58 without reverting other providers.
import { DEFAULTS, HUGGINGFACE_API_BASE } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';
import { offlineGrouping, offlineEntries, putOffline } from './offline.js';
import { inferChatFormat } from './huggingface-chat.js';

const QUANTS = /(?:^|[.\-_])((?:IQ|Q)\d[\w]*|BF16|F16|F32)(?=[.\-]|$)/i;
async function hubJson(url, env, opId) {
    const headers = env.HUGGINGFACE_API_KEY ? { Authorization: `Bearer ${env.HUGGINGFACE_API_KEY}` } : {};
    const res = await fetchWithTimeout(url, { headers }, DEFAULTS.HF_FETCH_TIMEOUT_MS, opId);
    if (!res.ok) throw new Error(`HuggingFace HTTP ${res.status}`);
    return res.json();
}
export function eligibleRepository(model) {
    return typeof model?.id === 'string' && /^[^/]+\/[^/]+$/.test(model.id)
        && !model.private && !model.gated
        && Number.isFinite(model.downloads) && model.downloads >= 1000
        && (model.likes >= 50 || model.downloads >= 50000)
        && (!model.pipeline_tag || model.pipeline_tag === 'text-generation')
        && !/uncensored|crack/i.test(model.id);
}

export function repositoryVariants(meta, opId = 'hf') {
    const grouped = {};
    for (const file of meta.siblings || []) {
        const path = file.rfilename;
        // The current client accepts one URL. A shard or projector alone isn't a runnable model.
        if (typeof path !== 'string' || !/\.gguf$/i.test(path) || /(?:^|[\/_.-])(?:mmproj|projector|mtp|draft|adapter)(?:[\/_.-]|$)|[-_]\d{5}-of-\d{5}/i.test(path)) continue;
        const quant = path.match(QUANTS)?.[1]?.toUpperCase();
        if (!quant || !Number.isFinite(file.size) || file.size <= 0) continue;
        const size = Math.round(file.size / 1048576);
        const url = `https://huggingface.co/${meta.id}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;
        const location = offlineGrouping({ repoId: meta.id, url });
        // Include the exact file identity: two recipes with the same quant must never overwrite each other.
        const id = `${meta.id}:${path}`;
        const license = meta.cardData?.license;
        const context = meta.gguf?.context_length || meta.config?.max_position_embeddings;
        const model = {
            id, source: 'huggingface', type: 'offline', tier: 'free', url,
            size, ram: size + 2000, ramEstimated: true,
            description: {}, details: { en: { title: `${location.series} ${location.variant}` } },
            modalities: { image: false, audio: false, file: true }, outputs: { text: true, image: false },
            reasoning: false, webSearch: false, chatFormat: inferChatFormat(meta.id, meta.tags || []),
            ...(Number.isFinite(context) && context > 0 ? { context } : {}),
            huggingface: { repoId: meta.id, path, quant, likes: meta.likes ?? 0, downloads: meta.downloads ?? 0,
                lastModified: meta.lastModified ?? null, ...(typeof license === 'string' ? { license } : {}) },
        };
        putOffline(grouped, location, model);
    }
    return grouped;
}

export async function buildGroupedHuggingFaceModels(env, opId, blacklist = new Set(), current = {}) {
    const grouped = {};
    const previous = [...offlineEntries(current)].filter(e => e.model.source === 'huggingface');
    const blocked = m => blacklist.has(m.id) || blacklist.has(m.huggingface?.repoId || m.id.split(':')[0]);
    const retain = entries => entries.forEach(e => { if (!blocked(e.model)) putOffline(grouped, { provider: e.p, series: e.s, variant: e.v }, e.model); });
    let candidates;
    try {
        // Request ranking fields and repository access metadata together.
        const query = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(DEFAULTS.HF_DISCOVERY_CANDIDATES), full: 'true' });
        const models = await hubJson(`${HUGGINGFACE_API_BASE}?${query}`, env, opId);
        if (!Array.isArray(models) || models.length === 0) throw new Error('Empty or invalid HF catalog');
        candidates = models.filter(eligibleRepository).filter(m => !blacklist.has(m.id))
            .sort((a, b) => (b.likes || 0) - (a.likes || 0) || b.downloads - a.downloads || a.id.localeCompare(b.id))
            .slice(0, DEFAULTS.HF_DISCOVERY_REPOS);
        if (!candidates.length) throw new Error('No eligible HF repositories; retaining previous catalog');
    } catch (error) {
        console.warn(`[${opId}] HF discovery unavailable: ${error.message}. Retaining existing HF models.`);
        retain(previous);
        return { grouped };
    }
    for (let i = 0; i < candidates.length; i += DEFAULTS.HF_MAX_CONCURRENT_REPOS) {
        const batch = await Promise.all(candidates.slice(i, i + DEFAULTS.HF_MAX_CONCURRENT_REPOS).map(async candidate => {
            try {
                const meta = await hubJson(`${HUGGINGFACE_API_BASE}/${candidate.id}?blobs=true`, env, opId);
                if (!Array.isArray(meta.siblings)) throw new Error('Missing HF file metadata');
                if (meta.private || meta.gated) return [];
                return [...offlineEntries(repositoryVariants({ ...candidate, ...meta, id: candidate.id }))];
            } catch (error) {
                console.warn(`[${opId}] HF repo ${candidate.id}: ${error.message}; retaining previous variants.`);
                return previous.filter(e => (e.model.huggingface?.repoId || e.model.id.split(':')[0]) === candidate.id);
            }
        }));
        batch.forEach(retain);
    }
    console.log(`[${opId}] HF discovery: ${candidates.length} repositories, ${[...offlineEntries(grouped)].length} GGUF variants.`);
    return { grouped };
}

// Keep curated text/status fields, but let source-owned download metadata actually update.
export function applyFreshHuggingFaceMetadata(final, fresh) {
    const byId = new Map([...offlineEntries(fresh)].filter(e => e.model.source === 'huggingface').map(e => [e.model.id, e.model]));
    for (const { model } of offlineEntries(final)) {
        if (model.source !== 'huggingface') continue;
        const next = byId.get(model.id);
        if (!next) continue;
        for (const field of ['url', 'size', 'ram', 'ramEstimated', 'huggingface']) model[field] = next[field];
    }
}
