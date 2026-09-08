/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Model Deduplicator
 * Description: Deduplicates models sharing the same ID across multiple providers.
 * Follows strict priority order: groq > cloudflare > openrouter > fal > elevenlabs > deepgram.
 * HuggingFace / offline (manual) models are completely excluded from deduplication.
 */

import { SOURCE_PRIORITY } from '../config.js';

/**
 * Normalizes model ID to detect equivalent models across providers.
 * e.g. "@cf/meta/llama-3.3-70b-instruct" <-> "meta-llama/llama-3.3-70b-instruct" <-> "llama-3.3-70b-instruct"
 * @param {string} id
 * @param {string} [source]
 * @returns {string}
 */
export function normalizeModelId(id, source = "") {
    if (!id || typeof id !== 'string') return "";
    let clean = id.toLowerCase().trim();
    clean = clean.replace(/:free$/i, "");

    const src = String(source || "").toLowerCase().trim();

    // Media providers: keep the full path because each subpath is a distinct task/model
    if (src === 'fal') {
        return clean.replace(/^fal-ai\//i, "");
    }
    if (src === 'elevenlabs' || src === 'deepgram') {
        return clean;
    }

    // LLM providers (groq, cloudflare, openrouter):
    // Strip Cloudflare @cf/ prefix (e.g. "@cf/meta/llama-3.3-70b-instruct" -> "meta/llama-3.3-70b-instruct")
    clean = clean.replace(/^@cf\//i, "");

    // Strip standard provider prefix to match canonical model base
    clean = clean.replace(/^(meta-llama|meta|openai|mistralai|google|anthropic|qwen|deepseek|groq)\//i, "");

    return clean;
}

/**
 * Deduplicates online models across the producers tree using source priority.
 * Manual (HuggingFace/offline) models are preserved without modification.
 * Priority: groq (6) > cloudflare (5) > openrouter (4) > fal (3) > elevenlabs (2) > deepgram (1).
 *
 * @param {object} producers - The grouped producers data.
 * @param {string} operationId - Logging operation ID.
 * @returns {object} The deduplicated producers data.
 */
export function deduplicateProducers(producers, operationId) {
    const opId = `${operationId}-dedup`;
    if (!producers || typeof producers !== 'object') return producers;

    // 1. Collect all online entries: canonicalId -> list of { pName, sName, vName, model, priority }
    const modelMap = new Map();

    for (const pName of Object.keys(producers)) {
        for (const sName of Object.keys(producers[pName] || {})) {
            if (sName === 'series_description') continue;
            for (const vName of Object.keys(producers[pName][sName] || {})) {
                if (vName === 'series_description' || vName === 'hidden') continue;

                const model = producers[pName][sName][vName];
                if (!model || typeof model !== 'object') continue;

                // CRITICAL RULE: HuggingFace / manual offline models are NEVER deduplicated.
                if (model.source === 'manual') {
                    continue;
                }

                const rawId = String(model.id || "").toLowerCase().trim();
                const source = String(model.source || "").toLowerCase().trim();
                const normId = normalizeModelId(model.id, source);
                const priority = SOURCE_PRIORITY[source] || 0;

                const entry = { pName, sName, vName, model, priority, rawId, source };

                // Group by normalized ID (as well as exact raw ID)
                const key = normId || rawId;
                if (!modelMap.has(key)) {
                    modelMap.set(key, []);
                }
                modelMap.get(key).push(entry);
            }
        }
    }

    // 2. Resolve duplicates: for any ID with >1 model, keep the highest priority
    let removedCount = 0;
    for (const [key, entries] of modelMap.entries()) {
        if (entries.length <= 1) continue;

        // Sort descending by priority: groq (6) > cloudflare (5) > openrouter (4) > fal (3) > elevenlabs (2) > deepgram (1)
        entries.sort((a, b) => b.priority - a.priority);

        const winner = entries[0];
        const losers = entries.slice(1);

        for (const loser of losers) {
            delete producers[loser.pName][loser.sName][loser.vName];
            removedCount++;
            console.log(`✂️ [${opId}] Dedup: [${winner.source}] "${winner.model.id}" won over [${loser.source}] "${loser.model.id}" for key "${key}"`);
        }
    }

    // 3. Clean up empty series and producers resulting from pruning
    for (const pName of Object.keys(producers)) {
        for (const sName of Object.keys(producers[pName] || {})) {
            if (sName === 'series_description') continue;
            const remainingVariants = Object.keys(producers[pName][sName]).filter(
                k => k !== 'series_description' && k !== 'hidden'
            );
            if (remainingVariants.length === 0) {
                delete producers[pName][sName];
            }
        }
        if (Object.keys(producers[pName]).length === 0) {
            delete producers[pName];
        }
    }

    if (removedCount > 0) {
        console.log(`✅ [${opId}] Deduplication finished. Removed ${removedCount} duplicate lower-priority model(s).`);
    } else {
        console.log(`✅ [${opId}] Deduplication finished. No duplicate models found.`);
    }

    return producers;
}
