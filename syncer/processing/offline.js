// Offline-only grouping: never rename online models or roleplay characters.
const FAMILIES = [
    [/gemma/i, 'Gemma', 'Google'], [/llama/i, 'Llama', 'Meta'],
    [/qwen/i, 'Qwen', 'Qwen'], [/nemotron/i, 'Nemotron', 'NVIDIA'],
    [/deepseek/i, 'DeepSeek', 'DeepSeek'], [/mixtral/i, 'Mixtral', 'Mistral AI'],
    [/mistral/i, 'Mistral', 'Mistral AI'], [/phi/i, 'Phi', 'Microsoft'],
    [/gpt-oss/i, 'GPT-OSS', 'OpenAI'],
];
export function offlineGrouping(model) {
    const repo = model.repoId?.split('/')[1];
    let filename = '';
    try { filename = decodeURIComponent(new URL(model.url).pathname.split('/').pop()); } catch {}
    const quant = filename.match(/(?:^|[.\-_])((?:IQ|Q)\d[\w]*|BF16|F16|F32)(?=[.\-]|$)/i)?.[1]?.toUpperCase();
    const raw = (repo || model.id || model.details?.en?.title || 'Offline').replace(/[-_]GGUF$/i, '');
    const family = FAMILIES.find(([re]) => re.test(raw));
    let series = raw.replace(/[-_]/g, ' ');
    let variant = model.details?.en?.title || series;
    if (family) {
        const [, name] = family;
        const start = raw.search(family[0]);
        const tail = raw.slice(start + name.length);
        const version = tail.match(/^[-_ ]?(\d+(?:\.\d+)*)(?![\d.]|[bBmM])/);
        series = name + (version ? ` ${version[1]}` : '');
        variant = raw.slice(0, start).replace(/[-_]/g, ' ').trim();
        const remainder = tail.slice(version ? version[0].length : 0).replace(/[-_]/g, ' ').trim();
        variant = [variant, remainder].filter(Boolean).join(' ');
    }
    variant = variant.replace(/\b(it|instruct)\b/gi, 'Instruct').replace(/\b(\d+(?:\.\d+)?)(b|m)\b/gi, (_, n, u) => n + u.toUpperCase()).trim();
    return {
        provider: model.producer || family?.[2] || model.repoId?.split('/')[0] || 'Vertex',
        series: model.series || series,
        variant: model.variant || `${variant || 'Base'}${quant ? ` (${quant})` : ''}`,
    };
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
