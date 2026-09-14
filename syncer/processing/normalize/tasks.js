/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Task & Category Mapping (normalize/tasks.js)
 * Description: Maps provider task names / categories / ids to canonical
 * CortexModel categories, and normalizes modality lists.
 */

import { INPUT_MODALITIES, OUTPUT_MODALITIES } from './schema.js';

/** Cloudflare Workers AI task.name -> canonical category. */
const CF_TASK_CATEGORY = {
    'text generation': 'chat',
    'text embeddings': 'embedding',
    'reranker': 'reranking',
    'text-to-image': 'image-gen',
    'image-to-text': 'chat', // captioning / VQA -> vision-capable chat
    'speech recognition': 'stt',
    'automatic speech recognition': 'stt',
    'text-to-speech': 'tts',
    'translation': 'translation',
    'summarization': 'chat',
    'classification': 'other',
    'object detection': 'other',
    'image classification': 'other',
    'audio classification': 'other',
};

export function categoryFromTaskName(taskName) {
    return CF_TASK_CATEGORY[String(taskName || '').toLowerCase().trim()] || 'other';
}

/** Fal category -> canonical category. Media-ingest rules live in catalog-policy.js. */
const FAL_CATEGORY = {
    'text-to-image': 'image-gen',
    'image-to-image': 'image-edit',
    'text-to-video': 'video-gen',
    'image-to-video': 'video-gen',
    'video-to-video': 'video-edit',
    'text-to-speech': 'tts',
    'text-to-audio': 'audio-gen',
    'audio-to-audio': 'audio-gen',
    'speech-to-speech': 'audio-gen',
};

export function categoryFromFalCategory(category) {
    return FAL_CATEGORY[String(category || '').toLowerCase().trim()] || null;
}

/** Groq id -> category (whisper = STT, safeguard/prompt-guard = moderation, orpheus = TTS, else chat). */
export function categoryFromGroqId(id) {
    const lower = String(id || '').toLowerCase();
    if (lower.includes('whisper')) return 'stt';
    if (lower.includes('prompt-guard') || lower.includes('safeguard')) return 'moderation';
    if (lower.includes('orpheus')) return 'tts';
    return 'chat';
}

/** ElevenLabs model -> category (TTS, Scribe-style STT, or STS voice conversion). */
export function categoryFromElevenLabsModel(model, modelId) {
    // Scribe is a speech-to-text family even when the provider omits the
    // capability booleans from its model inventory response. Check it before
    // the historical TTS default so realtime Scribe records enter the same
    // normalized STT catalog as Deepgram.
    if (/scribe|speech[-_ ]?to[-_ ]?text|\bstt\b/i.test(String(modelId || '')) || model?.can_do_speech_to_text === true) return 'stt';
    if (model?.can_do_text_to_speech !== false) return 'tts';
    if (model?.can_do_voice_conversion) return 'sts'; // speech-to-speech voice conversion
    return 'tts';
}

/**
 * Normalizes provider modality lists to canonical values.
 * @param {string[]} [list]
 * @param {boolean} [outputs=false] - Use output modality vocabulary.
 */
export function normalizeModalityList(list, outputs = false) {
    const vocabulary = outputs ? OUTPUT_MODALITIES : INPUT_MODALITIES;
    // Providers use 'speech' for spoken-audio output (e.g. Groq orpheus); canonical is 'audio'.
    const canonical = { speech: 'audio' };
    const values = Array.isArray(list) ? list : [];
    return [...new Set(values.map(v => canonical[String(v).toLowerCase().trim()] || String(v).toLowerCase().trim())
        .filter(v => vocabulary.includes(v)))];
}

/**
 * Derives the plain capability booleans implied by a category + modality set.
 * Only provider-declared modalities are used — no heuristics here.
 */
export function capabilitiesFromCategory(category, input, output) {
    const has = list => value => Array.isArray(list) && list.includes(value);
    const inMod = has(input), outMod = has(output);
    return {
        chat: category === 'chat' || null,
        imageInput: inMod('image') || null,
        audioInput: inMod('audio') || null,
        videoInput: inMod('video') || null,
        fileInput: inMod('file') || null,
        textOutput: outMod('text') || null,
        imageOutput: outMod('image') || null,
        audioOutput: outMod('audio') || null,
        videoOutput: outMod('video') || null,
        imageGeneration: category === 'image-gen' || null,
        videoGeneration: category === 'video-gen' || null,
        speechToText: category === 'stt' || null,
        textToSpeech: category === 'tts' || null,
        embeddings: category === 'embedding' || null,
        moderation: category === 'moderation' || null,
        translation: category === 'translation' || null,
    };
}
