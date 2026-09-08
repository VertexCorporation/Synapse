import { FAMILY_ASSETS, PRODUCER_ASSETS } from '../config/client-assets.js';

export const RESTRICTED_SOURCES = new Set(['cloudflare', 'deepgram', 'elevenlabs', 'fal']);
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PRODUCER_ALIASES = { 'meta-llama': 'meta', mistralai: 'mistral', stabilityai: 'stable', stability: 'stable', 'black-forest-labs': 'flux', blackforestlabs: 'flux', alibaba: 'wan', 'z-ai': 'z.ai', 'liquid-ai': 'liquid', 'lmstudio-community': 'lm', 'mistral-ai': 'mistral', 'stability-ai': 'stable' };

function producerMatch(producer) {
    const alias = PRODUCER_ALIASES[String(producer || '').toLowerCase()];
    if (alias) return { key: alias, asset: PRODUCER_ASSETS[alias] || FAMILY_ASSETS[alias] };
    const key = Object.keys(PRODUCER_ASSETS).find(key => normalize(key) === normalize(producer));
    return key ? { key, asset: PRODUCER_ASSETS[key] } : null;
}

// Check the primary model namespace, never descriptions or arbitrary nested adapter paths.
export function matchCatalogModel(source, id) {
    if (!RESTRICTED_SOURCES.has(source) || typeof id !== 'string') return null;
    let owner = '', slug = id;
    if (source === 'cloudflare') {
        const parts = id.replace(/^@(?:cf|hf)\//i, '').split('/');
        [owner, slug = ''] = parts;
    } else if (source === 'fal') {
        const parts = id.split('/');
        if (parts.length < 2) return null;
        owner = parts[0]; slug = parts[1];
        // Third-party wrappers are not models made by the vendor named deeper in the URL.
        if (owner !== 'fal-ai') return producerMatch(owner);
    } else if (source === 'elevenlabs') {
        return { key: 'elevenlabs', asset: FAMILY_ASSETS.elevenlabs };
    }
    const normalizedSlug = String(slug).toLowerCase();
    const key = Object.keys(FAMILY_ASSETS).sort((a, b) => b.length - a.length).find(key => {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[- ]/g, '[-_ ]?');
        return new RegExp(`^${escaped}(?=$|[^a-z]|[0-9])`, 'i').test(normalizedSlug);
    });
    if (key) return { key, asset: FAMILY_ASSETS[key] };
    return producerMatch(owner) || producerMatch(slug);
}

export function insertCatalogModel(grouped, producer, series, variant, model) {
    const match = matchCatalogModel(model.source, model.id);
    if (!match) return false;
    if ([producer, series, variant].some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) return false;
    grouped[producer] ??= {};
    grouped[producer][series] ??= {};
    const variants = grouped[producer][series];
    // Preserve API identity when multiple endpoints share a display name.
    const key = variants[variant] && variants[variant].id !== model.id ? `${variant} [${model.id}]` : variant;
    variants[key] = { ...model, catalogMatch: match };
    return true;
}

export function enforceCatalogPolicy(producers) {
    for (const [p, series] of Object.entries(producers || {})) {
        if (!series || typeof series !== 'object') continue;
        let producerChanged = false;
        for (const [s, variants] of Object.entries(series)) {
            if (!variants || typeof variants !== 'object') continue;
            let removed = false;
            for (const [v, model] of Object.entries(variants)) {
                if (!RESTRICTED_SOURCES.has(model?.source)) continue;
                const match = matchCatalogModel(model.source, model.id);
                if (!match) { delete variants[v]; removed = true; }
                else model.catalogMatch = match;
            }
            if (removed && !Object.values(variants).some(model => model?.id)) {
                delete series[s]; producerChanged = true;
            }
        }
        if (producerChanged && !Object.keys(series).length) delete producers[p];
    }
    return producers;
}
