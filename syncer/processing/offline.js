// Offline-only grouping: never rename online models or roleplay characters.
const FAMILIES = [
    [/glm/i, 'GLM', 'Z.AI'], [/kimi/i, 'Kimi', 'Moonshot AI'],
    [/granite/i, 'Granite', 'IBM'], [/ministral/i, 'Ministral', 'Mistral AI'],
    [/magistral/i, 'Magistral', 'Mistral AI'], [/devstral/i, 'Devstral', 'Mistral AI'],
    [/codestral/i, 'Codestral', 'Mistral AI'], [/pixtral/i, 'Pixtral', 'Mistral AI'],
    [/hermes/i, 'Hermes', 'Nous Research'], [/lfm/i, 'LFM', 'Liquid AI'],
    [/supernova/i, 'SuperNova', 'Arcee AI'],
    [/(?:^|[^a-z])jan(?:[-_ ]?nano|(?=[^a-z]|$))/i, 'Jan', 'Menlo Research'],
    [/(?:^|[^a-z])zeta(?=[^a-z]|$)/i, 'Zeta', 'Zed Industries'],
    [/nemotron/i, 'Nemotron', 'NVIDIA'], [/tinyllama/i, 'TinyLlama', 'Meta'],
    [/gemma/i, 'Gemma', 'Google'], [/llama/i, 'Llama', 'Meta'],
    [/qwen/i, 'Qwen', 'Qwen'], [/next/i, 'Next', 'Next'],
    [/deepseek/i, 'DeepSeek', 'DeepSeek'], [/mixtral/i, 'Mixtral', 'Mistral AI'],
    [/mistral/i, 'Mistral', 'Mistral AI'], [/phi/i, 'Phi', 'Microsoft'],
    [/gpt[-_ ]?oss/i, 'ChatGPT', 'OpenAI'], [/command/i, 'Command', 'Cohere'],
    [/aya/i, 'Aya', 'Cohere'],
];
export const OFFLINE_FAMILIES = new Set(FAMILIES.map(([, name]) => name));

// File recipes are download choices, not model variants. Keep one deterministic
// representative per full model name, preserving generations and parameter sizes.
export function deduplicateOfflineModels(producers) {
    const chosen = new Map();
    const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseName = model => offlineGrouping(model.huggingface?.repoId ? {
        ...model, variant: model.huggingface.repoId.split('/').pop().replace(/[-_]GGUF$/i, ''),
    } : model).variant
        .replace(/\s*\((?:(?:IQ|Q)\d[\w ]*|BF16|F16|F32)\)\s*$/i, '').trim();
    const rank = model => {
        if (model.source === 'manual') return -1;
        const quant = model.huggingface?.quant ||
            model.url?.match(/(?:[-_.])((?:IQ|Q)\d[\w]*|BF16|F16|F32)(?=[.\-]|$)/i)?.[1];
        const order = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q4_1', 'IQ4_XS', 'IQ4_NL', 'Q5_K_M', 'Q5_K_S', 'Q6_K', 'Q8_0'];
        const index = order.indexOf(quant?.toUpperCase());
        return index < 0 ? order.length : index;
    };
    const entries = [...offlineEntries(producers)];
    for (const entry of entries) {
        if (entry.model.type !== 'offline') continue;
        const key = normalize(entry.s) + ':' + normalize(baseName(entry.model));
        const previous = chosen.get(key);
        if (!previous || rank(entry.model) < rank(previous.model) ||
            (rank(entry.model) === rank(previous.model) && entry.model.id.localeCompare(previous.model.id) < 0)) {
            chosen.set(key, entry);
        }
    }
    const keep = new Set(chosen.values());
    for (const entry of entries) {
        if (entry.model.type !== 'offline') continue;
        if (!keep.has(entry)) delete producers[entry.p][entry.s][entry.v];
    }
    for (const entry of chosen.values()) {
        const title = baseName(entry.model);
        entry.model.title = title;
        // Model names are identity labels; translated descriptions remain intact.
        for (const details of Object.values(entry.model.details || {})) {
            if (details && typeof details === 'object' && typeof details.title === 'string') details.title = title;
        }
    }
    for (const {p, s, model} of entries) {
        if (model.type !== 'offline' || !producers[p]?.[s]) continue;
        if (!Object.values(producers[p][s]).some(v => v?.id)) delete producers[p][s];
        if (!Object.values(producers[p]).some(v => v && typeof v === 'object' && Object.values(v).some(m => m?.id))) delete producers[p];
    }
    return producers;
}

export function offlineGrouping(model) {
    const repoId = model.repoId || model.huggingface?.repoId;
    let filename = '';
    try { filename = decodeURIComponent(new URL(model.url).pathname.split('/').pop()); } catch {}
    const quant = filename.match(/(?:^|[.\-_])((?:IQ|Q)\d[\w]*|BF16|F16|F32)(?=[.\-]|$)/i)?.[1]?.toUpperCase();
    const raw = (repoId?.split('/')[1] || model.id || model.details?.en?.title || 'Offline')
        .replace(/[-_](?:GGUF|GGML)$/i, '');
    const family = FAMILIES.find(([re]) => re.test(raw));
    const series = family?.[1] || model.series || raw.replace(/[-_]/g, ' ');
    // Version, parameter count and quantization belong to the variant, not the
    // family. Keep the full label, like May's Next / Next 1B + Next 4B contract.
    let variant = model.variant || model.details?.en?.title || raw;
    if (quant) variant = variant.replace(/\s*\((?:(?:IQ|Q)\d[\w ]*|BF16|F16|F32)\)\s*$/i, '').trim();
    variant = variant.replace(/[-_]/g, ' ').replace(/\b(it|instruct)\b/gi, 'Instruct')
        .replace(/\b(\d+(?:\.\d+)?)(b|m)\b/gi, (_, n, u) => n + u.toUpperCase()).trim();
    if (quant && !variant.toUpperCase().includes(quant.replaceAll('_', ' ')) && !variant.toUpperCase().includes(quant)) variant += ` (${quant})`;
    return { provider: family?.[2] || model.producer || repoId?.split('/')[0] || 'Vertex', series, variant };
}

// Also repair retained records after an API outage or when serving an older KV
// document. Model IDs, download URLs, translations and size metadata survive.
export function regroupOfflineModels(producers) {
    const result = {};
    for (const { p, s, v, model, series } of offlineEntries(producers)) {
        const location = model.type === 'offline' ? offlineGrouping(model) : { provider: p, series: s, variant: v };
        if (model.source === 'huggingface' && !OFFLINE_FAMILIES.has(location.series)) continue;
        putOffline(result, location, model);
        for (const key of ['series_description', 'hidden']) {
            if (series[key] !== undefined && result[location.provider][location.series][key] === undefined) {
                result[location.provider][location.series][key] = series[key];
            }
        }
    }
    for (const [owner, value] of Object.entries(producers)) {
        if (result[owner] && value.series_description !== undefined) result[owner].series_description = value.series_description;
    }
    for (const key of Object.keys(producers)) delete producers[key];
    Object.assign(producers, result);
    return producers;
}

export function* offlineEntries(producers = {}) {
    for (const [p, series] of Object.entries(producers || {})) {
        if (!series || typeof series !== 'object') continue;
        for (const [s, variants] of Object.entries(series)) {
            if (!variants || typeof variants !== 'object') continue;
            for (const [v, model] of Object.entries(variants)) {
                if (model && typeof model === 'object' && model.id) yield { p, s, v, model, series: variants };
            }
        }
    }
}

export function putOffline(grouped, location, model) {
    const { provider, series } = location;
    if ([provider, series, location.variant].some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) return;
    grouped[provider] ??= {};
    grouped[provider][series] ??= {};
    const variants = grouped[provider][series];
    let key = location.variant;
    if (variants[key] && variants[key].id !== model.id) key += ` [${model.id}]`;
    variants[key] = model;
}

// Move existing enrichment with its identity before the ordinary merger prunes old keys.
export function migrateOfflineEnrichment(current, fresh) {
    const old = new Map([...offlineEntries(current)].filter(e => ['manual', 'huggingface', 'fal'].includes(e.model.source)).map(e => [e.model.id, e]));
    const moves = [...offlineEntries(fresh)].filter(entry => ['manual', 'huggingface', 'fal'].includes(entry.model.source))
        .map(entry => ({ entry, previous: old.get(entry.model.id) }))
        .filter(({ entry, previous }) => previous && (previous.p !== entry.p || previous.s !== entry.s || previous.v !== entry.v));
    for (const { previous } of moves) delete current[previous.p][previous.s][previous.v];
    for (const { entry, previous } of moves) {
        current[entry.p] ??= {};
        current[entry.p][entry.s] ??= {};
        current[entry.p][entry.s][entry.v] = previous.model;
        for (const key of ['series_description', 'hidden']) {
            if (previous.series[key] !== undefined && current[entry.p][entry.s][key] === undefined) current[entry.p][entry.s][key] = previous.series[key];
        }
    }
}

// Keep online entries byte-for-byte intact even if a display key collides.
export function mergeOfflineModels(online, huggingface, manual) {
    const result = structuredClone(online);
    for (const tree of [huggingface, manual]) {
        for (const { p, s, v, model } of offlineEntries(tree)) {
            putOffline(result, { provider: p, series: s, variant: v }, model);
        }
    }
    return result;
}
