import { consolidateFalModels } from './fal-models.js';
import { insertCatalogModel, matchCatalogModel } from './catalog-policy.js';
/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Fal.ai Model Processor
 * Description: Fetches and processes media models from the Fal.ai API.
 * Applies a strict curated whitelist to filter out community noise, LoRA trainers,
 * and internal utilities, ingesting only flagship models from premier AI creators.
 */

import { FAL_URL } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';

/**
 * Curated whitelist of premier model providers and their default series.
 */
const TRUSTED_FAL_PRODUCERS = {
    blackforestlabs: { producer: "Black Forest Labs", defaultSeries: "Flux" },
    flux: { producer: "Black Forest Labs", defaultSeries: "Flux" },
    kling: { producer: "Kling", defaultSeries: "Kling Video" },
    minimax: { producer: "MiniMax", defaultSeries: "Hailuo Video" },
    hailuo: { producer: "MiniMax", defaultSeries: "Hailuo Video" },
    luma: { producer: "Luma AI", defaultSeries: "Dream Machine" },
    recraft: { producer: "Recraft", defaultSeries: "Recraft" },
    ideogram: { producer: "Ideogram", defaultSeries: "Ideogram" },
    bytedance: { producer: "ByteDance", defaultSeries: "Seedance" },
    seedance: { producer: "ByteDance", defaultSeries: "Seedance" },
    seedream: { producer: "ByteDance", defaultSeries: "Seedream" },
    google: { producer: "Google", defaultSeries: "Veo" },
    veo: { producer: "Google", defaultSeries: "Veo" },
    wan: { producer: "Wan", defaultSeries: "Wan Video" },
    alibaba: { producer: "Wan", defaultSeries: "Wan Video" },
    pixverse: { producer: "PixVerse", defaultSeries: "PixVerse" },
    stabilityai: { producer: "Stability AI", defaultSeries: "Stable Diffusion" },
    stability: { producer: "Stability AI", defaultSeries: "Stable Diffusion" },
    "stable-diffusion": { producer: "Stability AI", defaultSeries: "Stable Diffusion" },
    "stable-audio": { producer: "Stability AI", defaultSeries: "Stable Audio" },
    sdxl: { producer: "Stability AI", defaultSeries: "SDXL" },
    bria: { producer: "Bria", defaultSeries: "Bria" },
    topaz: { producer: "Topaz", defaultSeries: "Topaz Upscale" },
    runway: { producer: "Runway", defaultSeries: "Gen-3" },
    vidu: { producer: "Vidu", defaultSeries: "Vidu" },
    hunyuan: { producer: "Tencent", defaultSeries: "Hunyuan" },
    tencent: { producer: "Tencent", defaultSeries: "Hunyuan" },
    kokoro: { producer: "Kokoro", defaultSeries: "Kokoro TTS" },
    xai: { producer: "xAI", defaultSeries: "Grok Imagine" },
    openai: { producer: "OpenAI", defaultSeries: "GPT Image" },
    lightricks: { producer: "Lightricks", defaultSeries: "LTX Video" },
    ltx: { producer: "Lightricks", defaultSeries: "LTX Video" },
    playht: { producer: "PlayHT", defaultSeries: "PlayHT Voice" },
    meshy: { producer: "Meshy", defaultSeries: "Meshy 3D" },
    tripo3d: { producer: "Tripo3D", defaultSeries: "Tripo 3D" }
};

/**
 * Categories excluded from media model ingestion.
 */
const EXCLUDED_CATEGORIES = new Set([
    "training", "workflow", "json", "text-to-json", "image-to-json",
    "video-to-text", "speech-to-text", "audio-to-text", "llm"
]);

/**
 * Substrings that indicate non-production models, training nodes, or duplicates.
 */
const EXCLUDED_SUBSTRINGS = [
    "trainer", "training", "lora", "workflow-utilities", "image-preprocessors",
    "post-processing", "apps-v2", "benchmark", "demo", "test", "eval", "internal",
    "router", "elevenlabs"
];

/**
 * Parses producer, series, and variant name from Fal model endpoint and metadata.
 * @param {string} endpointId
 * @param {object} metadata
 * @returns {{producer: string, series: string, variant: string} | null}
 */
export function parseFalModelIdentity(endpointId, metadata = {}) {
    const idLower = endpointId.toLowerCase();
    const parts = endpointId.split("/");
    const root = parts[0].toLowerCase();
    const sub = (parts[1] || "").toLowerCase();

    let matchedKey = null;
    for (const key of Object.keys(TRUSTED_FAL_PRODUCERS)) {
        if (root === key || (root === "fal-ai" && new RegExp(`^${key}(?:$|[-_/0-9])`, "i").test(sub))) {
            matchedKey = key;
            break;
        }
    }
    if (!matchedKey) {
        const match = matchCatalogModel('fal', endpointId);
        if (!match) return null;
        const name = match.key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        return { producer: name, series: name, variant: metadata.display_name || parts.slice(1).join(' ') };
    }

    const conf = TRUSTED_FAL_PRODUCERS[matchedKey];
    const producer = conf.producer;
    let series = conf.defaultSeries;

    // Refine series based on id keywords
    if (producer === "ByteDance") {
        if (idLower.includes("seedream")) series = "Seedream";
        else if (idLower.includes("seedance")) series = "Seedance";
        else if (idLower.includes("seaweed")) series = "Seaweed";
        else if (idLower.includes("sdxl-lightning")) series = "SDXL Lightning";
    } else if (producer === "Google") {
        if (idLower.includes("veo")) series = "Veo";
        else if (idLower.includes("banana")) series = "Nano Banana";
        else if (idLower.includes("imagen")) series = "Imagen";
    } else if (producer === "Stability AI") {
        if (idLower.includes("audio")) series = "Stable Audio";
        else if (idLower.includes("svd")) series = "Stable Video";
        else if (idLower.includes("sdxl")) series = "SDXL";
        else series = "Stable Diffusion";
    } else if (producer === "MiniMax") {
        if (idLower.includes("speech") || idLower.includes("audio") || idLower.includes("voice")) series = "MiniMax Speech";
        else series = "Hailuo Video";
    } else if (producer === "Tencent") {
        if (idLower.includes("3d")) series = "Hunyuan 3D";
        else if (idLower.includes("video")) series = "Hunyuan Video";
        else series = "Hunyuan Image";
    }

    let variant = (metadata?.display_name || "").trim();
    if (!variant || variant === endpointId) {
        variant = parts.slice(1).join(" ")
            .replace(/[-_]/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    return { producer, series, variant };
}

/**
 * Fetches and filters models from Fal.ai API using cursor pagination.
 * @param {import('../types.js').Env} env
 * @param {string} operationId
 * @param {Set<string>} blacklistedIds
 * @returns {Promise<{grouped: object}>}
 */
export async function buildGroupedFalModels(env, operationId, blacklistedIds) {
    const opId = `${operationId}-fal`;
    console.log(`🎨 [${opId}] Starting curated Fal.ai model fetching...`);

    const headers = { "Content-Type": "application/json" };
    const apiKey = env.FAL_KEY || env.FAL_API_KEY;
    if (apiKey) {
        headers["Authorization"] = `Key ${apiKey}`;
    }

    const grouped = {};
    let cursor = null;
    let pageCount = 0;
    let totalFetched = 0;
    let kept = 0;
    let skippedNoise = 0;

    try {
        do {
            pageCount++;
            const url = cursor ? `${FAL_URL}?cursor=${encodeURIComponent(cursor)}` : FAL_URL;
            const response = await fetchWithTimeout(url, { headers }, env.FETCH_TIMEOUT_MS || 30000, opId);
            
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Fal.ai API failed with status ${response.status}: ${errText.substring(0, 150)}`);
            }

            const data = await response.json();
            const models = data?.models || [];
            totalFetched += models.length;

            for (const item of models) {
                const endpointId = item.endpoint_id;
                if (!endpointId) continue;
                if (blacklistedIds && blacklistedIds.has(endpointId)) continue;
                if (!matchCatalogModel('fal', endpointId)) continue;

                const meta = item.metadata || {};
                const category = String(meta.category || "").toLowerCase();
                const idLower = endpointId.toLowerCase();

                // 1. Exclude non-media or utility categories
                if (EXCLUDED_CATEGORIES.has(category)) {
                    skippedNoise++;
                    continue;
                }

                // 2. Exclude trainers, loras, workflows, and test nodes
                if (EXCLUDED_SUBSTRINGS.some(s => idLower.includes(s))) {
                    skippedNoise++;
                    continue;
                }

                // 3. Match against trusted producer whitelist
                const identity = parseFalModelIdentity(endpointId, meta);
                if (!identity) {
                    skippedNoise++;
                    continue;
                }

                const tags = Array.isArray(meta.tags) ? meta.tags.map(t => String(t).toLowerCase()) : [];

                const isImageInput = category.includes("image-to-") || tags.includes("image-to-image") || tags.includes("image-to-video") || idLower.includes("image-to-");
                const isVideoInput = category.includes("video-to-") || idLower.includes("video-to-");
                const isAudioInput = category.includes("audio-to-") || category.includes("speech-to-") || idLower.includes("audio-to-");

                const isImageOutput = category.includes("text-to-image") || category.includes("image-to-image") || idLower.includes("image") || idLower.includes("flux") || idLower.includes("upscale") || idLower.includes("sdxl");
                const isVideoOutput = category.includes("video") || idLower.includes("video");
                const isAudioOutput = category.includes("audio") || category.includes("speech") || category.includes("tts") || idLower.includes("audio") || idLower.includes("speech");

                const { producer, series, variant } = identity;

                insertCatalogModel(grouped, producer, series, variant, {
                    id: endpointId,
                    source: "fal",
                    falEndpoint: { category, group: meta.group?.key || null },
                    tier: "standard",
                    description: { en: meta.description || meta.display_name || endpointId },
                    context: 0,
                    modalities: {
                        image: isImageInput,
                        video: isVideoInput,
                        audio: isAudioInput,
                        file: false,
                    },
                    outputs: {
                        image: isImageOutput,
                        video: isVideoOutput,
                        audio: isAudioOutput,
                    },
                    reasoning: false,
                    webSearch: false,
                });
                kept++;
            }

            cursor = data.has_more && data.next_cursor ? data.next_cursor : null;
        } while (cursor && pageCount < 30);

        console.log(`🎨 [${opId}] Fal.ai models complete: fetched ${totalFetched}, kept ${kept} curated models (${skippedNoise} noise/unlisted filtered) across ${pageCount} page(s).`);
    } catch (e) {
        console.warn(`⚠️ [${opId}] Fal.ai fetching ended with warning: ${e.message}`);
    }

    const consolidated = consolidateFalModels(grouped, blacklistedIds);
    console.log(`[${opId}] Consolidated task endpoints into base model records.`);
    return { grouped: consolidated };
}
