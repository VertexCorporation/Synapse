/*
 * Gateway - Workers AI pricing
 * Workers AI reports token counts but not money, so cost = tokens x the model's published
 * per-million-token price. Prices come from three places, most specific first:
 *   1. MODEL_PRICES var (JSON override, e.g. {"@cf/meta/llama-3.3-70b-instruct-fp8-fast":{"input":0.293,"output":2.253}})
 *   2. the live catalog (GET /ai/models/search, whose `price` property carries USD per M tokens)
 *   3. the table below, a snapshot of developers.cloudflare.com/workers-ai/platform/pricing
 * A model with no price anywhere cannot be metered and is refused.
 */

// Workers AI bills in neurons: $0.011 per 1,000 (developers.cloudflare.com/workers-ai/platform/pricing).
// When a response reports `usage.neurons` that figure is used as-is; the token prices below are the
// fallback for responses that do not.
export const USD_PER_NEURON = 0.011 / 1000;

/** USD cost of a request from the neurons Workers AI reported for it. */
export function costFromNeurons(neurons) {
    return Math.round(neurons * USD_PER_NEURON * 1e9) / 1e9;
}

// USD per million tokens: [input, output]. Snapshot taken 2026-09-13.
export const BUILTIN_PRICES = {
    '@cf/meta/llama-3.2-1b-instruct': [0.027, 0.201],
    '@cf/meta/llama-3.2-3b-instruct': [0.051, 0.335],
    '@cf/meta/llama-3.1-8b-instruct-fp8-fast': [0.045, 0.384],
    '@cf/meta/llama-3.2-11b-vision-instruct': [0.049, 0.676],
    '@cf/meta/llama-3.1-70b-instruct-fp8-fast': [0.293, 2.253],
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [0.293, 2.253],
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': [0.497, 4.881],
    '@cf/deepseek-ai/deepseek-v4-flash-0731': [0.440, 1.320],
    '@cf/deepseek-ai/deepseek-v4-pro-0813': [1.320, 3.960],
    '@cf/mistral/mistral-7b-instruct-v0.1': [0.110, 0.190],
    '@cf/mistralai/mistral-small-3.1-24b-instruct': [0.351, 0.555],
    '@cf/meta/llama-3.1-8b-instruct': [0.282, 0.827],
    '@cf/meta/llama-3.1-8b-instruct-fp8': [0.152, 0.287],
    '@cf/meta/llama-3.1-8b-instruct-awq': [0.123, 0.266],
    '@cf/meta/llama-3-8b-instruct': [0.282, 0.827],
    '@cf/meta/llama-3-8b-instruct-awq': [0.123, 0.266],
    '@cf/meta/llama-2-7b-chat-fp16': [0.556, 6.667],
    '@cf/meta/llama-guard-3-8b': [0.484, 0.030],
    '@cf/meta/llama-4-scout-17b-16e-instruct': [0.270, 0.850],
    '@cf/google/gemma-3-12b-it': [0.345, 0.556],
    '@cf/google/gemma-4-26b-a4b-it': [0.100, 0.300],
    '@cf/qwen/qwq-32b': [0.660, 1.000],
    '@cf/qwen/qwen2.5-coder-32b-instruct': [0.660, 1.000],
    '@cf/qwen/qwen3-30b-a3b-fp8': [0.051, 0.335],
    '@cf/qwen/qwen3.8-27b': [0.450, 3.200],
    '@cf/openai/gpt-oss-120b': [0.350, 0.750],
    '@cf/openai/gpt-oss-20b': [0.200, 0.300],
    '@cf/aisingapore/gemma-sea-lion-v4-27b-it': [0.351, 0.555],
    '@cf/ibm-granite/granite-4.0-h-micro': [0.017, 0.112],
    '@cf/zai-org/glm-4.7-flash': [0.060, 0.400],
    '@cf/zai-org/glm-5.2': [1.400, 4.400],
    '@cf/zai-org/glm-5.3': [1.400, 4.400],
    '@cf/zai-org/glm-5.3-flash': [0.150, 0.500],
    '@cf/nvidia/nemotron-3-120b-a12b': [0.500, 1.500],
    '@cf/moonshotai/kimi-k2.5': [0.600, 3.000],
    '@cf/moonshotai/kimi-k2.6': [0.950, 4.000],
    '@cf/moonshotai/kimi-k2.7-code': [0.950, 4.000],
    // Embeddings: input only.
    '@cf/baai/bge-small-en-v1.5': [0.020, 0],
    '@cf/baai/bge-base-en-v1.5': [0.067, 0],
    '@cf/baai/bge-large-en-v1.5': [0.204, 0],
    '@cf/baai/bge-m3': [0.012, 0],
    '@cf/pfnet/plamo-embedding-1b': [0.019, 0],
    '@cf/qwen/qwen3-embedding-0.6b': [0.012, 0],
};

const CHAT_TASKS = new Set(['text generation']);
const EMBEDDING_TASKS = new Set(['text embeddings']);

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Reads USD-per-million-token prices from a catalog item's `price` property rows.
 * Rows look like { unit: "per M input tokens", price: 0.293, currency: "USD" }.
 * @returns {{inputPerM: number, outputPerM: number}|null}
 */
export function pricesFromProperty(rows) {
    if (!Array.isArray(rows)) return null;
    const usd = rows.filter(r => r && (!r.currency || String(r.currency).toUpperCase() === 'USD'));
    const find = (needle) => usd.find(r => String(r.unit || '').toLowerCase().includes(needle));
    const input = find('input');
    const output = find('output');
    const generic = usd.find(r => /per m tokens/i.test(String(r.unit || '')));
    const inputPerM = num(input?.price) ?? num(generic?.price);
    if (inputPerM == null) return null;
    const outputPerM = num(output?.price) ?? (input ? 0 : num(generic?.price)) ?? 0;
    return { inputPerM, outputPerM };
}

/**
 * Turns one /ai/models/search item into a catalog entry, or null when it is not a priced
 * chat/embedding model.
 */
export function catalogEntry(item) {
    const id = item?.name || item?.id;
    if (!id) return null;
    const task = String(item?.task?.name || '').toLowerCase();
    const kind = CHAT_TASKS.has(task) ? 'chat' : EMBEDDING_TASKS.has(task) ? 'embedding' : null;
    if (!kind) return null;
    const props = {};
    for (const entry of Array.isArray(item.properties) ? item.properties : []) {
        if (entry?.property_id) props[entry.property_id] = entry.value;
    }
    const prices = pricesFromProperty(props.price);
    return {
        id,
        kind,
        description: typeof item.description === 'string' ? item.description : null,
        contextWindow: num(props.context_window ?? props.max_context),
        inputPerM: prices?.inputPerM ?? null,
        outputPerM: prices?.outputPerM ?? null,
    };
}

/**
 * Fetches every page of the Workers AI model catalog.
 * @returns {Promise<Array<ReturnType<typeof catalogEntry>>>}
 */
export async function fetchCatalog(env, { perPage = 100, maxPages = 20 } = {}) {
    const base = (env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    const entries = [];
    for (let page = 1; page <= maxPages; page++) {
        const res = await fetch(`${base}/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?page=${page}&per_page=${perPage}`, {
            headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        });
        if (!res.ok) throw new Error(`models/search returned ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data?.result) ? data.result : [];
        for (const item of list) {
            const entry = catalogEntry(item);
            if (entry) entries.push(entry);
        }
        if (list.length < perPage) break;
    }
    return entries;
}

export function parsePriceOverrides(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        const out = {};
        for (const [id, value] of Object.entries(parsed || {})) {
            const inputPerM = num(value?.input);
            const outputPerM = num(value?.output) ?? 0;
            if (inputPerM != null) out[id] = { inputPerM, outputPerM };
        }
        return out;
    } catch {
        console.error('[GATEWAY] MODEL_PRICES is not valid JSON; ignoring.');
        return {};
    }
}

/**
 * Resolves the price for a model: override > live catalog > built-in snapshot.
 * @param {string} model
 * @param {Array|null} catalog Entries from fetchCatalog (may be null when unavailable).
 * @param {object} overrides From parsePriceOverrides.
 * @returns {{inputPerM: number, outputPerM: number, source: string}|null}
 */
export function priceFor(model, catalog, overrides = {}) {
    if (overrides[model]) return { ...overrides[model], source: 'override' };
    const live = Array.isArray(catalog) ? catalog.find(e => e.id === model) : null;
    if (live && live.inputPerM != null) return { inputPerM: live.inputPerM, outputPerM: live.outputPerM ?? 0, source: 'catalog' };
    const builtin = BUILTIN_PRICES[model];
    if (builtin) return { inputPerM: builtin[0], outputPerM: builtin[1], source: 'builtin' };
    return null;
}

/**
 * USD cost of a request given its price and token counts.
 */
export function costFor(price, promptTokens, completionTokens) {
    const input = (promptTokens || 0) * price.inputPerM / 1e6;
    const output = (completionTokens || 0) * price.outputPerM / 1e6;
    return Math.round((input + output) * 1e9) / 1e9;
}

/**
 * Rough token estimate used only when the upstream response carries no usage block.
 * Deliberately generous (3 characters per token) so a missing usage never under-charges.
 * @param {number} chars Character count of the text.
 */
export function estimateTokensFromChars(chars) {
    const n = Number(chars);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.ceil(n / 3);
}

export function estimateTokens(text) {
    return estimateTokensFromChars(text ? String(text).length : 0);
}

/**
 * Models the gateway can serve: every priced chat/embedding model known from any source.
 */
export function listPricedModels(catalog, overrides = {}) {
    const byId = new Map();
    for (const [id, [inputPerM, outputPerM]] of Object.entries(BUILTIN_PRICES)) {
        byId.set(id, { id, kind: outputPerM === 0 && /embedding|bge-/i.test(id) ? 'embedding' : 'chat', inputPerM, outputPerM, source: 'builtin', contextWindow: null, description: null });
    }
    for (const entry of Array.isArray(catalog) ? catalog : []) {
        const price = entry.inputPerM != null ? { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM ?? 0, source: 'catalog' } : null;
        const prev = byId.get(entry.id);
        if (price) byId.set(entry.id, { ...entry, ...price });
        else if (prev) byId.set(entry.id, { ...prev, description: entry.description, contextWindow: entry.contextWindow });
    }
    for (const [id, price] of Object.entries(overrides)) {
        const prev = byId.get(id) || { id, kind: 'chat', contextWindow: null, description: null };
        byId.set(id, { ...prev, ...price, source: 'override' });
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}
