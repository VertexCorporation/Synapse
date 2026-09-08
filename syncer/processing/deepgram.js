import { insertCatalogModel, matchCatalogModel } from './catalog-policy.js';
/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Deepgram Model Processor
 * Description: Fetches and processes STT and TTS models from the Deepgram API.
 * Transforms models into Cortex ProducersData format.
 */

import { DEEPGRAM_URL } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';

/**
 * Fetches models from Deepgram API.
 * @param {import('../types.js').Env} env
 * @param {string} operationId
 * @param {Set<string>} blacklistedIds
 * @returns {Promise<{grouped: object}>}
 */
export async function buildGroupedDeepgramModels(env, operationId, blacklistedIds) {
    const opId = `${operationId}-deepgram`;
    console.log(`🔊 [${opId}] Starting Deepgram model fetching...`);

    const headers = { "Content-Type": "application/json" };
    const apiKey = env.DEEPGRAM_KEY || env.DEEPGRAM_API_KEY;
    if (apiKey) {
        headers["Authorization"] = `Token ${apiKey}`;
    }

    const grouped = {};
    let kept = 0;

    try {
        const response = await fetchWithTimeout(DEEPGRAM_URL, { headers }, env.FETCH_TIMEOUT_MS || 30000, opId);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Deepgram API failed with status ${response.status}: ${errText.substring(0, 150)}`);
        }

        const data = await response.json();
        const producer = "Deepgram";

        // 1. Process STT (Speech-to-Text) models
        const sttList = Array.isArray(data?.stt) ? data.stt : [];
        for (const model of sttList) {
            const modelId = model.canonical_name || model.name;
            if (!modelId) continue;
            if (blacklistedIds && blacklistedIds.has(modelId)) continue;
                if (!matchCatalogModel('deepgram', modelId)) continue;

            const name = (model.name || modelId).trim();
            const series = modelId.toLowerCase().startsWith("nova") ? "Nova" : "STT";
            const variant = name.replace(/^nova\s*[-_]?/i, "Nova ").trim() || name;

            insertCatalogModel(grouped, producer, series, variant, {
                id: modelId,
                source: "deepgram",
                tier: "standard",
                description: { en: `Deepgram ${name} speech-to-text model (${model.architecture || "general"})` },
                context: 0,
                modalities: {
                    image: false,
                    video: false,
                    audio: true, // Accepts audio input
                    file: false,
                },
                outputs: {
                    image: false,
                    video: false,
                    audio: false, // Outputs text
                },
                reasoning: false,
                webSearch: false,
            });
            kept++;
        }

        // 2. Process TTS (Text-to-Speech) models
        const ttsList = Array.isArray(data?.tts) ? data.tts : [];
        for (const model of ttsList) {
            const modelId = model.canonical_name || model.name;
            if (!modelId) continue;
            if (blacklistedIds && blacklistedIds.has(modelId)) continue;
                if (!matchCatalogModel('deepgram', modelId)) continue;

            const name = (model.name || modelId).trim();
            const series = "Aura";
            const variant = name.charAt(0).toUpperCase() + name.slice(1);

            insertCatalogModel(grouped, producer, series, variant, {
                id: modelId,
                source: "deepgram",
                tier: "standard",
                description: { en: `Deepgram Aura ${variant} natural text-to-speech voice` },
                context: 0,
                modalities: {
                    image: false,
                    video: false,
                    audio: false,
                    file: false,
                },
                outputs: {
                    image: false,
                    video: false,
                    audio: true, // Outputs audio
                },
                reasoning: false,
                webSearch: false,
            });
            kept++;
        }

        console.log(`🔊 [${opId}] Deepgram models complete: kept ${kept} models.`);
    } catch (e) {
        console.warn(`⚠️ [${opId}] Deepgram fetching failed: ${e.message}`);
    }

    return { grouped };
}
