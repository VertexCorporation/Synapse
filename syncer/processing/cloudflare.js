import { insertCatalogModel, matchCatalogModel } from './catalog-policy.js';
/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Cloudflare Workers AI Model Processor
 * Description: Fetches and processes models from Cloudflare Workers AI API.
 * Transforms models into Cortex ProducersData format.
 */

import { PRODUCER_MAP } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';

/**
 * Extracts producer, series, and variant from Cloudflare model name.
 * e.g. "@cf/meta/llama-3.3-70b-instruct" -> Producer: "Meta", Series: "Llama", Variant: "3.3 70B Instruct"
 * @param {string} cfName
 * @returns {{producer: string, series: string, variant: string}}
 */
function parseCloudflareModelIdentity(cfName) {
    const raw = cfName.replace(/^@(?:cf|hf)\//i, "");
    const parts = raw.split("/");
    const org = parts[0] || "cloudflare";
    const slug = parts[1] || parts[0];

    let producer = PRODUCER_MAP[org.toLowerCase()] || org.charAt(0).toUpperCase() + org.slice(1);
    let series = "Cloudflare";
    let variant = slug.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    if (/llama/i.test(slug)) {
        series = "Llama";
        variant = slug.replace(/^llama-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || slug;
    } else if (/qwen/i.test(slug)) {
        series = "Qwen";
        variant = slug.replace(/^qwen-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || slug;
    } else if (/mistral/i.test(slug)) {
        series = "Mistral";
        variant = slug.replace(/^mistral-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || slug;
    } else if (/gpt-oss/i.test(slug)) {
        series = "GPT-OSS";
        variant = slug.replace(/^gpt-oss-?/i, "").replace(/[-_]/g, " ").trim() || slug;
    } else if (/deepseek/i.test(slug)) {
        series = "DeepSeek";
        variant = slug.replace(/^deepseek-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || slug;
    } else if (/gemma/i.test(slug)) {
        series = "Gemma";
        variant = slug.replace(/^gemma-?[\d.]*-?/i, "").replace(/[-_]/g, " ").trim() || slug;
    } else if (/flux/i.test(slug)) {
        series = "Flux";
        variant = slug.replace(/[-_]/g, " ").trim();
    } else if (/stable-diffusion/i.test(slug) || /sdxl/i.test(slug)) {
        series = "Stable Diffusion";
        variant = slug.replace(/[-_]/g, " ").trim();
    } else if (/whisper/i.test(slug)) {
        series = "Whisper";
        variant = slug.replace(/[-_]/g, " ").trim();
    }

    return { producer, series, variant };
}

/**
 * Fetches all models from Cloudflare Workers AI API.
 * @param {import('../types.js').Env} env
 * @param {string} operationId
 * @param {Set<string>} blacklistedIds
 * @returns {Promise<{grouped: object}>}
 */
export async function buildGroupedCloudflareModels(env, operationId, blacklistedIds) {
    const opId = `${operationId}-cloudflare`;
    console.log(`☁️ [${opId}] Starting Cloudflare Workers AI model fetching...`);

    const accountId = env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;

    if (!accountId || !apiToken) {
        console.warn(`⚠️ [${opId}] CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not configured. Skipping Cloudflare Workers AI.`);
        return { grouped: {} };
    }

    const headers = {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
    };

    const grouped = {};
    let page = 1;
    let totalFetched = 0;
    let kept = 0;
    const perPage = 50;

    try {
        while (true) {
            const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?page=${page}&per_page=${perPage}`;
            const response = await fetchWithTimeout(url, { headers }, env.FETCH_TIMEOUT_MS || 30000, opId);
            
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Cloudflare API failed with status ${response.status}: ${errText.substring(0, 150)}`);
            }

            const data = await response.json();
            const list = Array.isArray(data?.result) ? data.result : [];
            totalFetched += list.length;

            for (const item of list) {
                const modelId = item.name || item.id;
                if (!modelId) continue;
                if (blacklistedIds && blacklistedIds.has(modelId)) continue;
                if (!matchCatalogModel('cloudflare', modelId)) continue;

                const taskName = String(item.task?.name || "").toLowerCase();
                const isImageOutput = taskName.includes("text-to-image") || taskName.includes("image generation");
                const isAudioOutput = taskName.includes("text-to-speech");
                const isImageInput = taskName.includes("image-to-text") || taskName.includes("visual question answering") || taskName.includes("image classification");
                const isAudioInput = taskName.includes("speech recognition") || taskName.includes("automatic speech recognition");

                const { producer, series, variant } = parseCloudflareModelIdentity(modelId);

                insertCatalogModel(grouped, producer, series, variant, {
                    id: modelId,
                    source: "cloudflare",
                    tier: "standard",
                    description: { en: item.description || modelId },
                    context: item.properties?.max_context || 0,
                    modalities: {
                        image: isImageInput,
                        video: false,
                        audio: isAudioInput,
                        file: false,
                    },
                    outputs: {
                        image: isImageOutput,
                        video: false,
                        audio: isAudioOutput,
                    },
                    reasoning: taskName.includes("text generation"),
                    webSearch: false,
                });
                kept++;
            }

            const resultInfo = data?.result_info;
            if (!resultInfo || page * perPage >= (resultInfo.total_count || 0) || list.length === 0) {
                break;
            }
            page++;
            if (page > 10) break; // Safety limit
        }

        console.log(`☁️ [${opId}] Cloudflare models complete: fetched ${totalFetched}, kept ${kept} models across ${page} page(s).`);
    } catch (e) {
        console.warn(`⚠️ [${opId}] Cloudflare fetching failed: ${e.message}`);
    }

    return { grouped };
}
