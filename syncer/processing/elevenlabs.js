import { insertCatalogModel, matchCatalogModel } from './catalog-policy.js';
/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: ElevenLabs Model Processor
 * Description: Fetches and processes voice models from the ElevenLabs API.
 * Transforms models into Cortex ProducersData format.
 */

import { ELEVENLABS_URL } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';

/**
 * Fetches models from ElevenLabs API.
 * @param {import('../types.js').Env} env
 * @param {string} operationId
 * @param {Set<string>} blacklistedIds
 * @returns {Promise<{grouped: object}>}
 */
export async function buildGroupedElevenLabsModels(env, operationId, blacklistedIds) {
    const opId = `${operationId}-elevenlabs`;
    console.log(`🎙️ [${opId}] Starting ElevenLabs model fetching...`);

    const apiKey = env.ELEVENLABS_KEY || env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        console.warn(`⚠️ [${opId}] ELEVENLABS_KEY is not configured. Skipping ElevenLabs.`);
        return { grouped: {} };
    }

    const headers = {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
    };

    const grouped = {};
    let kept = 0;

    try {
        const response = await fetchWithTimeout(ELEVENLABS_URL, { headers }, env.FETCH_TIMEOUT_MS || 30000, opId);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`ElevenLabs API failed with status ${response.status}: ${errText.substring(0, 150)}`);
        }

        const models = await response.json();
        if (!Array.isArray(models)) {
            throw new Error("ElevenLabs API did not return an array of models.");
        }

        const producer = "ElevenLabs";
        const series = "Eleven Voice";

        for (const model of models) {
            const modelId = model.model_id;
            if (!modelId) continue;
            if (blacklistedIds && blacklistedIds.has(modelId)) continue;
                if (!matchCatalogModel('elevenlabs', modelId)) continue;

            const name = (model.name || modelId).trim();
            const variant = name.replace(/^Eleven\s+/i, "").trim() || name;

            insertCatalogModel(grouped, producer, series, variant, {
                id: modelId,
                source: "elevenlabs",
                tier: "standard",
                description: { en: model.description || name },
                context: model.max_characters_request_subscribed_user || model.maximum_text_length_per_request || 10000,
                modalities: {
                    image: false,
                    video: false,
                    audio: !!model.can_do_voice_conversion,
                    file: false,
                },
                outputs: {
                    image: false,
                    video: false,
                    audio: model.can_do_text_to_speech !== false,
                },
                reasoning: false,
                webSearch: false,
            });
            kept++;
        }

        console.log(`🎙️ [${opId}] ElevenLabs models complete: kept ${kept} models.`);
    } catch (e) {
        console.warn(`⚠️ [${opId}] ElevenLabs fetching failed: ${e.message}`);
    }

    return { grouped };
}
