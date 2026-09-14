/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Catalog Schema (normalize/schema.js)
 * Description: Canonical CortexModel construction, provenance triplets,
 * validation and metadata-quality rollup for the additive `catalog` array.
 *
 * Invariants (design doc §5):
 *  - Unknown facts are NULL (never 0 / false / "") unless the provider said so.
 *  - Facts that can be inferred are provenance triplets { value, source, confidence }.
 *  - Company / series identity is catalog-carried, never client-inferred.
 */

import { SOURCE_PRIORITY } from '../../config.js';

export const CATALOG_SOURCES = Object.freeze([
    'openrouter', 'groq', 'cloudflare', 'fal', 'elevenlabs', 'deepgram', 'assemblyai', 'manual', 'huggingface',
]);

export const CATEGORIES = Object.freeze([
    'chat', 'embedding', 'reranking', 'moderation', 'translation',
    'image-gen', 'image-edit', 'video-gen', 'video-edit', 'audio-gen', 'tts', 'stt', 'sts', 'other',
]);

export const TASKS = Object.freeze([
    'realtime_stt',
]);

export const INPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'file']);
export const OUTPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video']);

/**
 * Builds a provenance triplet. Omitted when the value is unknown (null) so the
 * catalog stays compact; a plain (non-triplet) value means "provider-declared".
 * @param {*} value - The asserted value.
 * @param {string} source - Who asserted it ('provider id' | 'docs' | 'derived' | 'parsed_id' | 'heuristic' | 'curator').
 * @param {number} [confidence] - 0..1, omitted when 1.
 */
export function prov(value, source, confidence) {
    if (value === null || value === undefined) return null;
    const triplet = { value, source };
    if (typeof confidence === 'number' && confidence !== 1) triplet.confidence = confidence;
    return triplet;
}

/** Unwraps a triplet (or plain value) to its value, null-safe. */
export function valueOf(triplet) {
    if (triplet === null || triplet === undefined) return null;
    if (typeof triplet === 'object' && !Array.isArray(triplet)) return triplet.value ?? null;
    return triplet;
}

/** Stable record identity across sync runs. */
export function catalogRecordKey(record) {
    return `${record?.source}:${record?.id}`;
}

/**
 * Creates a full CortexModel skeleton with every fact null and empty containers.
 * @param {{id: string, source: string, canonicalKey: string, category: string, task?: string|null}} input
 */
export function createCortexModel({ id, source, canonicalKey, category, task = null }) {
    return {
        id, source, canonicalKey, category, task,
        identity: {
            displayName: null, producer: null, producerSlug: null, family: null,
            series: null, variant: null, parameterSize: null, version: null,
            huggingFaceId: null, baseModel: null, aliases: [],
        },
        lifecycle: {
            createdAt: null, updatedAt: null, deprecated: null, expiresAt: null,
            status: null, knowledgeCutoff: null,
        },
        capabilities: {
            chat: null, reasoning: null, tools: null, vision: null, streaming: null,
            structuredOutput: null, webSearch: null, embeddings: null, speechToText: null,
            textToSpeech: null, imageInput: null, audioInput: null, videoInput: null,
            fileInput: null, imageOutput: null, audioOutput: null, videoOutput: null,
            imageGeneration: null, videoGeneration: null, voiceCloning: null,
            moderation: null, translation: null, diarization: null, timestamps: null,
            realtime: null, automaticLanguageDetection: null, codeSwitching: null,
            interimResults: null, finalResults: null, vad: null, endpointing: null,
        },
        modalities: { input: [], output: [], architectureModality: null },
        limits: {
            contextTokens: null, maxOutputTokens: null, maxInputTokens: null,
            maxInputCharacters: null, maxAudioSeconds: null, maxImageMegapixels: null,
            maxBatchItems: null, estimatedGenerationSeconds: null,
        },
        pricing: {
            currency: null, inputPerToken: null, outputPerToken: null, cachedInputPerToken: null,
            request: null, image: null, webSearch: null, internalReasoningPerToken: null,
            perCharacter: null, costFactor: null, free: null,
        },
        reasoning: { supported: null, mandatory: null, efforts: null, defaultEffort: null },
        routing: {
            endpointIds: null, defaultEndpoint: null, regions: null, hardware: null,
            isModerated: null, languages: null, rateNotes: null, catalogMatch: null,
        },
        audio: {
            formats: null, sampleRates: null, channels: null, pcm: null,
        },
        performance: {
            firstTranscriptLatencyMs: null, finalTranscriptLatencyMs: null,
            noTranscriptRate: null, socketFailureRate: null,
            providerFailureRate: null, fallbackRate: null,
        },
        executionModes: {
            supportsInteractive: null,
            supportsBatch: null,
        },
        parameters: {},
        metadataQuality: { providerFields: 0, inferredFields: 0, unknownFields: 0, quality: 0 },
        firstSeenAt: null, lastSeenAt: null, absentStreak: 0,
        tier: null,
        routes: [],
        raw: null,
    };
}

// Fields counted by the metadata-quality rollup. Plain values count as
// provider-owned; triplets count by their `source` (provider id vs inferred).
const TRACKED_PATHS = [
    'identity.displayName', 'identity.producer', 'identity.family', 'identity.series',
    'identity.variant', 'identity.parameterSize', 'identity.version', 'identity.huggingFaceId', 'identity.baseModel',
    'lifecycle.createdAt', 'lifecycle.deprecated', 'lifecycle.status', 'lifecycle.knowledgeCutoff',
    'capabilities.chat', 'capabilities.reasoning', 'capabilities.tools', 'capabilities.vision',
    'capabilities.streaming', 'capabilities.structuredOutput', 'capabilities.webSearch',
    'capabilities.embeddings', 'capabilities.speechToText', 'capabilities.textToSpeech',
    'capabilities.imageInput', 'capabilities.audioInput', 'capabilities.videoInput', 'capabilities.fileInput',
    'capabilities.imageOutput', 'capabilities.audioOutput', 'capabilities.videoOutput',
    'capabilities.imageGeneration', 'capabilities.videoGeneration', 'capabilities.voiceCloning',
    'capabilities.moderation', 'capabilities.translation', 'capabilities.diarization', 'capabilities.timestamps',
    'capabilities.realtime', 'capabilities.automaticLanguageDetection', 'capabilities.codeSwitching',
    'capabilities.interimResults', 'capabilities.finalResults', 'capabilities.vad', 'capabilities.endpointing',
    'modalities.input', 'modalities.output', 'modalities.architectureModality',
    'limits.contextTokens', 'limits.maxOutputTokens', 'limits.maxInputCharacters', 'limits.estimatedGenerationSeconds',
    'pricing.inputPerToken', 'pricing.outputPerToken', 'pricing.free', 'pricing.perCharacter', 'pricing.costFactor',
    'reasoning.supported', 'reasoning.mandatory', 'reasoning.efforts',
    'executionModes.supportsInteractive', 'executionModes.supportsBatch',
    'routing.languages', 'routing.isModerated', 'routing.endpointIds', 'routing.defaultEndpoint',
    'audio.formats', 'audio.sampleRates', 'audio.channels', 'audio.pcm',
    'performance.firstTranscriptLatencyMs', 'performance.finalTranscriptLatencyMs',
    'performance.noTranscriptRate', 'performance.socketFailureRate',
    'performance.providerFailureRate', 'performance.fallbackRate',
];

function pathGet(obj, path) {
    let cur = obj;
    for (const part of path.split('.')) {
        if (cur === null || cur === undefined) return null;
        cur = cur[part];
    }
    return cur === undefined ? null : cur;
}

const REQUIRED_KEYS = new Set(['id', 'source', 'canonicalKey', 'category', 'metadataQuality']);
const KEEP_EMPTY_KEYS = new Set(['routes']); // always present, even when singleton
// modality lists are semantic facts: an empty output list means "no media output".
const KEEP_EMPTY_PATHS = /^modalities\.(input|output)$/;

function compactTree(node, root = true, path = '') {
    if (Array.isArray(node)) return node.filter(v => v !== null && v !== undefined);
    if (node === null || typeof node !== 'object') return node;
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (value === null || value === undefined) { delete node[key]; continue; }
        if (typeof value === 'object') {
            const childPath = path ? `${path}.${key}` : key;
            const compacted = compactTree(value, false, childPath);
            const emptyObject = compacted !== null && typeof compacted === 'object' && !Array.isArray(compacted)
                && Object.keys(compacted).length === 0;
            const emptyArray = Array.isArray(compacted) && compacted.length === 0;
            const keepEmpty = KEEP_EMPTY_PATHS.test(childPath);
            if ((emptyObject || emptyArray) && !keepEmpty && !root && !REQUIRED_KEYS.has(key) && !KEEP_EMPTY_KEYS.has(key)) {
                delete node[key];
            } else {
                node[key] = compacted;
            }
        }
    }
    return node;
}

/**
 * Computes the metadata-quality rollup and prunes null leaves / empty
 * containers (absence == unknown in the served document). Call once after the
 * normalizer populated the record.
 * @param {object} record - A CortexModel in progress.
 * @returns {object} The same record, finalized.
 */
export function finalizeCortexModel(record) {
    let providerFields = 0, inferredFields = 0, unknownFields = 0;
    for (const path of TRACKED_PATHS) {
        const value = pathGet(record, path);
        if (value === null || (Array.isArray(value) && value.length === 0)) { unknownFields++; continue; }
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value.source : null;
        if (source && source !== record.source) inferredFields++;
        else providerFields++;
    }
    for (const value of Object.values(record.parameters || {})) {
        if (value === null || value === undefined) unknownFields++;
        else providerFields++;
    }
    const total = providerFields + inferredFields + unknownFields;
    record.metadataQuality = {
        providerFields, inferredFields, unknownFields,
        quality: total ? Math.round(((providerFields + inferredFields) / total) * 100) / 100 : 0,
    };
    return compactTree(record);
}



/**
 * Structural validation of a CortexModel (used by tests and future guards).
 * @param {object} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCortexModel(record) {
    const errors = [];
    if (!record || typeof record !== 'object') return { ok: false, errors: ['record must be an object'] };
    if (typeof record.id !== 'string' || !record.id) errors.push('id must be a non-empty string');
    if (!CATALOG_SOURCES.includes(record.source)) errors.push(`source "${record.source}" is not a catalog source`);
    if (typeof record.canonicalKey !== 'string' || !record.canonicalKey) errors.push('canonicalKey must be a non-empty string');
    if (!CATEGORIES.includes(record.category)) errors.push(`category "${record.category}" is not one of ${CATEGORIES.join(', ')}`);
    if (record.task !== undefined && record.task !== null && !TASKS.includes(record.task)) {
        errors.push(`task "${record.task}" is not one of ${TASKS.join(', ')}`);
    }
    if (record.limits?.contextTokens !== undefined && record.limits?.contextTokens !== null
        && typeof record.limits.contextTokens !== 'number') errors.push('limits.contextTokens must be number|null');
    for (const [group, field] of [['identity', 'family'], ['capabilities', 'reasoning'], ['capabilities', 'tools'], ['lifecycle', 'deprecated']]) {
        const t = record[group]?.[field];
        if (t !== undefined && t !== null && (typeof t !== 'object' || Array.isArray(t) || !('value' in t) || !('source' in t))) {
            errors.push(`${group}.${field} must be a provenance triplet {{value, source}}`);
        }
    }
    // streaming is either a provider-declared boolean (Deepgram) or a derived triplet (OpenRouter docs).
    const streaming = record.capabilities?.streaming;
    if (streaming !== undefined && streaming !== null && typeof streaming !== 'boolean'
        && (typeof streaming !== 'object' || Array.isArray(streaming) || !('value' in streaming) || !('source' in streaming))) {
        errors.push('capabilities.streaming must be boolean or a provenance triplet {{value, source}}');
    }
    if (record.modalities && (!Array.isArray(record.modalities.input) || !Array.isArray(record.modalities.output))) {
        errors.push('modalities.input/output must be arrays');
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Deterministic, stable ordering for the catalog array so the content hash
 * does not churn when providers reorder their API responses.
 * @param {object[]} records
 */
export function sortCatalog(records) {
    return [...records].sort((a, b) =>
        String(a.canonicalKey).localeCompare(String(b.canonicalKey)) ||
        ((SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0)) ||
        String(a.id).localeCompare(String(b.id)));
}

/**
 * Size-guard degrade: drops `raw` payloads from catalog records when the KV
 * document exceeds the soft limit (design §9.6). Returns the stripped count.
 * @param {object[]} records
 */
export function stripCatalogRaw(records) {
    let stripped = 0;
    for (const record of records || []) {
        if (record && record.raw !== undefined && record.raw !== null) {
            delete record.raw;
            stripped++;
        }
    }
    return stripped;
}
