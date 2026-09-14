import { FAMILY_ASSETS, FAMILY_NAMES, PRODUCER_ASSETS } from '../config/client-assets.js';
import { ALLOWED_PROVIDER_IDS, PRODUCER_MAP } from '../config.js';

export const RESTRICTED_SOURCES = new Set(['manual', 'openrouter', 'groq', 'cloudflare', 'deepgram', 'assemblyai', 'elevenlabs', 'fal']);
const aliases = { 'deepseek-ai': 'deepseek', runwayml: 'runway', 'meta-llama': 'meta', mistralai: 'mistral', 'mistral-ai': 'mistral',
    stabilityai: 'stable', stability: 'stable', 'stability-ai': 'stable',
    'black-forest-labs': 'flux', blackforestlabs: 'flux', alibaba: 'wan',
    'x-ai': 'xai', 'z-ai': 'z.ai', 'liquid-ai': 'liquid', 'lmstudio-community': 'lm' };
const ownerKey = owner => aliases[owner] || owner;
const knownOwner = owner => ALLOWED_PROVIDER_IDS.includes(owner) ||
    Object.hasOwn(PRODUCER_ASSETS, ownerKey(owner)) || Object.hasOwn(FAMILY_NAMES, ownerKey(owner));
const extraSlugs = { hailuo: 'minimax', 'gpt-oss': 'gpt', qwq: 'qwen', sonar: 'perplexity',
    'nano-banana': 'banana', nanobanana: 'banana', 'stable-diffusion': 'stable' };
function familyMatch(slug) {
    const keys = [...Object.keys(FAMILY_NAMES), ...Object.keys(extraSlugs)].sort((a,b) => b.length-a.length);
    for (const alias of keys) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[- ]/g, '[-_ ]?');
        if (!new RegExp(`^${escaped}(?=$|[^a-z]|[0-9])`, 'i').test(slug)) continue;
        const key = extraSlugs[alias] || alias;
        return { key, asset: FAMILY_ASSETS[key], series: FAMILY_NAMES[key] };
    }
    return null;
}

// Match the actual model namespace. Neither arbitrary display text nor a company
// asset is sufficient to authorize a model. This also applies to free fallbacks.
export function matchCatalogModel(source, id) {
    if (!RESTRICTED_SOURCES.has(source) || typeof id !== 'string') return null;
    if (source === 'elevenlabs') {
        if (/^scribe(?:[_-]|$)/i.test(id)) return { key: 'scribe', asset: null, series: 'Scribe' };
        return /^eleven[_-]/i.test(id) ? familyMatch('elevenlabs') : null;
    }
    if (source === 'deepgram') return familyMatch(id);
    let parts = id.toLowerCase().replace(/^@(?:cf|hf)\//, '').split('/');
    let owner = parts.length > 1 ? parts.shift() : '';
    if (source === 'openrouter' && !ALLOWED_PROVIDER_IDS.includes(owner)) return null;
    if (source === 'fal' && owner === 'fal-ai') {
        owner = '';
        // Permit exactly one declared producer namespace: google/imagen4, etc.
        if (parts.length > 1 && knownOwner(parts[0]) && !familyMatch(parts[0])) owner = parts.shift();
    } else if (owner && !knownOwner(owner)) return null;
    const slug = parts[0] || '';
    let match = familyMatch(slug);
    if (!match && owner === 'openai' && /^o[1-9](?:$|[-:])/.test(slug)) match = familyMatch('gpt');
    // Model-series namespaces such as minimax/speech are allowed explicitly;
    // generic companies (Microsoft, Meta, Google, NVIDIA) are not series.
    if (!match && owner === 'arcee-ai') match = familyMatch('arcee');
    if (!match && ['minimax', 'runway', 'bria', 'topaz', 'elevenlabs'].includes(ownerKey(owner))) {
        match = familyMatch(ownerKey(owner));
    }
    return match;
}

/**
 * Alarm row for a restricted-source model that failed asset matching instead of
 * silently vanishing (design §9.2a). Deduplicated per id prefix per run.
 * @param {Set<string>} seen - Per-run dedup set (caller-owned).
 * @param {string} source
 * @param {string} id
 * @param {string} opId
 */
export function reportAssetAlarm(seen, source, id, opId) {
    const prefix = String(id).toLowerCase().replace(/^@(?:cf|hf)\//, '').split('/').slice(0, 3).join('/');
    const key = `${source}:${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.warn(`🚨 [${opId}] ALARM[asset-missing]: ${source} model "${id}" has no catalog asset match; excluded.`);
}

export function insertCatalogModel(grouped, producer, series, variant, model) {
    const match = matchCatalogModel(model.source, model.id);
    if (!match) return false;
    series = match.series;
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
    const result = {};
    for (const [producer, seriesMap] of Object.entries(producers || {})) {
        if (!seriesMap || typeof seriesMap !== 'object') continue;
        for (const [series, variants] of Object.entries(seriesMap)) {
            if (!variants || typeof variants !== 'object') continue;
            for (const [variant, model] of Object.entries(variants)) {
                if (!model?.id) continue;
                const offline = model.type === 'offline';
                const character = ['roleplay', 'self'].includes(model.type) || ['roleplay', 'self'].includes(model.category);
                const match = !offline && !character ? matchCatalogModel(model.source, model.id) : null;
                if (!offline && !character && !match) continue;
                const targetSeries = match?.series || series;
                const owner = producer === 'undefined' ? (PRODUCER_MAP[model.id.split('/')[0]] || producer) : producer;
                if ([owner, targetSeries, variant].some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) continue;
                result[owner] ??= {};
                result[owner][targetSeries] ??= {};
                const target = result[owner][targetSeries];
                const key = target[variant] && target[variant].id !== model.id ? `${variant} [${model.id}]` : variant;
                target[key] = match ? { ...model, catalogMatch: match } : model;
                for (const meta of ['series_description', 'hidden']) {
                    if (variants[meta] !== undefined && target[meta] === undefined) target[meta] = variants[meta];
                }
            }
        }
    }
    for (const [owner, value] of Object.entries(producers || {})) {
        if (result[owner] && value.series_description !== undefined) result[owner].series_description = value.series_description;
    }
    for (const key of Object.keys(producers || {})) delete producers[key];
    Object.assign(producers, result);
    return producers;
}
