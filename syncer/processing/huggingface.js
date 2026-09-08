/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: HuggingFace Metadata Refresher
 * Description: Offline (on-device GGUF) models were previously 100% static -
 * their `size`/`ram`/license info were whatever an admin typed once via the
 * Curator and never touched again. Online (OpenRouter) models get refreshed
 * every hour by `processing/online.js`; this module gives offline models the
 * same live-pull treatment by querying the HuggingFace Hub API for every
 * variant whose `url` points at a `huggingface.co/.../resolve/...` file.
 *
 * Runs as the LAST enrichment step in core/sync.js, directly on the final
 * merged producers tree, so its results can never be overwritten by the
 * KV rehydrate/merge step (which otherwise prefers old/frozen field values).
 */

import { fetchWithTimeout } from '../utils/api.js';
import { DEFAULTS, HUGGINGFACE_API_BASE } from '../config.js';

/**
 * @typedef {import('../types.js').ProducersData} ProducersData
 */

// Matches e.g. "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true"
const HF_URL_RE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/([^?#]+)/i;

/**
 * Extracts the HuggingFace repo id and in-repo file path from a resolve URL.
 * @param {unknown} url
 * @returns {{ repoId: string, path: string } | null}
 */
function parseHfUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    const m = url.match(HF_URL_RE);
    if (!m) return null;
    try {
        return { repoId: m[1], path: decodeURIComponent(m[2]) };
    } catch {
        return null;
    }
}

/**
 * Resolves the true byte size of a (possibly sharded) GGUF file from a repo's
 * sibling file list. Sharded files look like "...-00001-of-00003.gguf"; in
 * that case we sum every shard belonging to the same split so `size` reflects
 * the full quant (matching how these fields were originally hand-entered).
 * @param {Array<{rfilename: string, size?: number}>} siblings
 * @param {string} targetPath
 * @returns {number|null} Total size in bytes, or null if the file can't be found.
 */
function resolveFileSizeBytes(siblings, targetPath) {
    const shardMatch = targetPath.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (shardMatch) {
        const [, base, , total] = shardMatch;
        const prefix = `${base}-`;
        const suffix = `-of-${total}.gguf`;
        let sum = 0;
        let found = 0;
        for (const s of siblings) {
            if (typeof s.size === 'number' && s.rfilename.startsWith(prefix) && s.rfilename.endsWith(suffix)) {
                sum += s.size;
                found++;
            }
        }
        if (found === Number(total)) return sum;
        return null;
    }
    const exact = siblings.find((s) => s.rfilename === targetPath);
    return exact && typeof exact.size === 'number' ? exact.size : null;
}

/**
 * Walks a producers tree and collects every variant backed by a HuggingFace file.
 * Covers both standalone offline entries (source: 'manual') AND hybrid
 * entries where a Curator manually attached a GGUF download link onto an
 * otherwise online (OpenRouter) variant.
 * @param {ProducersData} producers
 * @returns {Array<{pName: string, sName: string, vName: string, variant: object, repoId: string, path: string}>}
 */
function collectHfVariants(producers) {
    const items = [];
    if (!producers || typeof producers !== 'object') return items;
    for (const pName in producers) {
        const series = producers[pName];
        if (!series || typeof series !== 'object') continue;
        for (const sName in series) {
            if (sName === 'series_description') continue;
            const variants = series[sName];
            if (!variants || typeof variants !== 'object') continue;
            for (const vName in variants) {
                if (vName === 'series_description' || vName === 'hidden') continue;
                const variant = variants[vName];
                if (!variant || typeof variant !== 'object') continue;
                const parsed = parseHfUrl(variant.url);
                if (parsed && variant.source !== 'huggingface') items.push({ pName, sName, vName, variant, ...parsed });
            }
        }
    }
    return items;
}

/**
 * Fetches a HuggingFace repo's metadata (including per-file blob sizes).
 * @param {string} repoId
 * @param {object} env
 * @param {string} opId
 */
async function fetchRepoMetadata(repoId, env, opId) {
    const headers = {};
    if (env.HUGGINGFACE_API_KEY) headers.Authorization = `Bearer ${env.HUGGINGFACE_API_KEY}`;

    const res = await fetchWithTimeout(
        `${HUGGINGFACE_API_BASE}/${repoId}?blobs=true`,
        { headers },
        DEFAULTS.HF_FETCH_TIMEOUT_MS,
        opId,
    );
    if (!res.ok) {
        throw new Error(`HF API returned ${res.status} for '${repoId}'`);
    }
    return res.json();
}

/**
 * Refreshes size/RAM/popularity/license metadata for every offline model whose
 * `url` points at a HuggingFace-hosted file, mutating `producers` and
 * `fallbackProducers` in place. Non-fatal: any repo-level failure is logged
 * and skipped, leaving that model's existing (last-known-good) data untouched.
 * @param {ProducersData} producers
 * @param {ProducersData} fallbackProducers
 * @param {object} env - The environment object (optionally provides HUGGINGFACE_API_KEY).
 * @param {string} operationId
 */
export async function refreshHuggingFaceModels(producers, fallbackProducers, env, operationId) {
    const opId = `${operationId}-hf`;
    const items = [...collectHfVariants(producers), ...collectHfVariants(fallbackProducers || {})];

    if (items.length === 0) {
        console.log(`[${opId}] No HuggingFace-hosted offline models found. Skipping.`);
        return;
    }

    /** @type {Map<string, typeof items>} */
    const byRepo = new Map();
    for (const item of items) {
        if (!byRepo.has(item.repoId)) byRepo.set(item.repoId, []);
        byRepo.get(item.repoId).push(item);
    }
    console.log(`[${opId}] Refreshing ${items.length} offline model variant(s) across ${byRepo.size} HuggingFace repo(s)...`);

    const repoIds = [...byRepo.keys()];
    const concurrency = DEFAULTS.HF_MAX_CONCURRENT_REPOS;
    let updated = 0;
    let skipped = 0;
    let failedRepos = 0;

    for (let i = 0; i < repoIds.length; i += concurrency) {
        const batch = repoIds.slice(i, i + concurrency);
        await Promise.all(batch.map(async (repoId) => {
            let meta;
            try {
                meta = await fetchRepoMetadata(repoId, env, opId);
            } catch (e) {
                console.warn(`[${opId}] Failed to fetch HF metadata for '${repoId}': ${e.message}. Keeping existing data for its model(s).`);
                failedRepos++;
                skipped += byRepo.get(repoId).length;
                return;
            }

            const siblings = Array.isArray(meta.siblings) ? meta.siblings : [];
            const licenseTag = (meta.tags || []).find((t) => typeof t === 'string' && t.startsWith('license:'));
            const license = meta.cardData?.license || (licenseTag ? licenseTag.split(':')[1] : null);

            for (const entry of byRepo.get(repoId)) {
                const bytes = resolveFileSizeBytes(siblings, entry.path);
                if (bytes == null) {
                    console.warn(`[${opId}] File '${entry.path}' not found in '${repoId}' anymore. Keeping existing size (model may have been re-quantized/moved).`);
                    skipped++;
                    continue;
                }

                const newSizeMb = Math.round(bytes / (1024 * 1024));
                const oldSizeMb = typeof entry.variant.size === 'number' ? entry.variant.size : newSizeMb;
                // Preserve whatever RAM headroom (buffer above raw file size) was
                // originally configured, rather than guessing a new one.
                const ramOverheadMb = typeof entry.variant.ram === 'number'
                    ? Math.max(entry.variant.ram - oldSizeMb, 0)
                    : 2000;

                entry.variant.size = newSizeMb;
                entry.variant.ram = newSizeMb + ramOverheadMb;
                entry.variant.huggingface = {
                    downloads: typeof meta.downloads === 'number' ? meta.downloads : null,
                    likes: typeof meta.likes === 'number' ? meta.likes : null,
                    lastModified: meta.lastModified ?? null,
                    ...(license && { license }),
                };
                entry.variant.lastHfSyncAt = new Date().toISOString();
                updated++;
            }
        }));
    }

    console.log(`[${opId}] Done. Updated: ${updated}, Skipped: ${skipped}, Failed repos: ${failedRepos}.`);
}
