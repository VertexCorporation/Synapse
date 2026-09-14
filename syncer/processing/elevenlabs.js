import { insertCatalogModel, matchCatalogModel, reportAssetAlarm } from './catalog-policy.js';
/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: ElevenLabs Model Processor
 * Description: Fetches and processes voice models from the ElevenLabs API.
 * Transforms models into Cortex ProducersData format.
 */

import { ELEVENLABS_URL } from '../config.js';
import { fetchWithTimeout } from '../utils/api.js';
import { normalizeModelId } from './dedup.js';
import { normalizeElevenLabsModel } from './normalize/elevenlabs.js';

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
        return { grouped: {}, records: [], health: { ok: true, disabled: true } };
    }

    const headers = {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
    };

    const grouped = {};
    const records = [];
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
        const alarmSeen = new Set();

        for (const model of models) {
            const modelId = model.model_id;
            if (!modelId) continue;
            if (blacklistedIds && blacklistedIds.has(modelId)) continue;
            const match = matchCatalogModel('elevenlabs', modelId);
            if (!match) {
                reportAssetAlarm(alarmSeen, 'elevenlabs', modelId, opId);
                continue;
            }

            const name = (model.name || modelId).trim();
            const series = match.series || "Eleven Voice";
            const variant = name.replace(/^Eleven\s+/i, "").trim() || name;

            // Catalog record: character limits land in limits.maxInputCharacters.
            records.push(normalizeElevenLabsModel(model, {
                identity: { producer, series, variant },
                canonicalKey: normalizeModelId(modelId, 'elevenlabs'),
                catalogMatch: match,
            }));

            insertCatalogModel(grouped, producer, series, variant, {
                id: modelId,
                source: "elevenlabs",
                tier: "standard",
                description: { en: model.description || name },
                // Character limits are NOT token context; the tree no longer
                // fabricates a context number for them (0 == unknown).
                context: 0,
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
        return { grouped, records, health: { ok: true, count: models.length, kept } };
    } catch (e) {
        console.warn(`⚠️ [${opId}] ElevenLabs fetching failed: ${e.message}`);
        return { grouped, records, health: { ok: false, error: e.message } };
    }
}
