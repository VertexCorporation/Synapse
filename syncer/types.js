/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Type Definitions
 * Description: Centralized JSDoc type definitions for the Syncer Worker.
 * Helps with code autocompletion, readability, and static analysis.
 */

/**
 * Represents the environment bindings available to the worker.
 * @typedef {object} Env
 * @property {KVNamespace} MODELS_JSON - KV namespace for model data.
 * @property {KVNamespace} [LOCKS] - Optional KV namespace for distributed locks.
 * @property {string} OPENROUTER_KEY - API key for OpenRouter.
 * @property {string} [FETCH_TIMEOUT_MS] - Optional fetch timeout override.
 * @property {string} [CACHE_TTL_S] - Optional cache TTL override.
 * @property {string} [STALE_TTL_S] - Optional stale-while-revalidate TTL override.
 * @property {string} [LOCK_TTL_S] - Optional lock TTL override.
 */

/**
 * Represents the structure of a single model variant in our final data format.
 * @typedef {object} ModelVariant
 * @property {string} id - The unique identifier of the model (e.g., "openai/gpt-4o").
 * @property {('openrouter'|'manual'|'huggingface')} source - The origin of the model data.
 * @property {string} tier - Catalog tier ('standard', 'fallback', or 'free' for offline models).
 * @property {object} [description] - Description for online models.
 * @property {string} [description.en] - The English description.
 * @property {number} [context] - The context length for online models.
 * @property {object} [modalities] - Input modalities for online models.
 * @property {object} [outputs] - Output modalities for online models.
 * @property {boolean} [reasoning] - Whether the model supports reasoning/tool use.
 * @property {boolean} [webSearch] - Whether the model supports web search.
 * @property {string} [type] - The type for manual models ('roleplay', 'offline').
 * @property {string} [url] - The download URL for manual offline models.
 * @property {string} [imagePath] - The storage path for the manual model's image.
 * @property {number} [size] - The size in MB for manual offline models.
 * @property {number} [ram] - The required RAM in MB for manual offline models.
 * @property {object} [details] - Detailed information for manual models.
 */

/**
 * Represents a series of models from a single producer.
 * It contains multiple model variants.
 * @typedef {{ [variantName: string]: ModelVariant }} ModelSeries
 */

/**
 * Represents all model series from a single producer.
 * @typedef {{ [seriesName: string]: ModelSeries }} ProducerModels
 */

/**
 * The final, top-level structure of our models data.
 * @typedef {{ [producerName: string]: ProducerModels }} ProducersData
 */

/**
 * A canonical catalog record (design doc §5). Served as the additive `catalog`
 * array of the /models document. Unknown facts are absent (null), never 0/false.
 * @typedef {object} CortexModel
 * @property {string} id - Provider-native model id (e.g. "openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b").
 * @property {('openrouter'|'groq'|'cloudflare'|'fal'|'elevenlabs'|'deepgram'|'manual'|'huggingface')} source
 * @property {string} canonicalKey - Cross-provider identity (normalizeModelId output).
 * @property {('chat'|'embedding'|'reranking'|'moderation'|'translation'|'image-gen'|'image-edit'|'video-gen'|'video-edit'|'audio-gen'|'tts'|'stt'|'other')} category
 * @property {object} identity - Company / series / variant placement (never client-inferred).
 * @property {string} [identity.displayName]
 * @property {string} [identity.producer] - Company display name (tree top level).
 * @property {string} [identity.producerSlug]
 * @property {{value: string, source: string, confidence?: number}} [identity.family] - Provenance triplet.
 * @property {string} [identity.series] - Series (tree second level).
 * @property {string} [identity.variant] - Variant (tree leaf key).
 * @property {{value: string, source: string, confidence?: number}} [identity.parameterSize]
 * @property {object} [lifecycle] - createdAt/updatedAt/deprecated/expiresAt/status/knowledgeCutoff.
 * @property {object} [capabilities] - Plain provider facts + reasoning/tools/streaming triplets.
 * @property {object} [modalities] - { input: string[], output: string[], architectureModality }.
 * @property {object} [limits] - contextTokens/maxOutputTokens/maxInputCharacters/... (null when unknown).
 * @property {object} [pricing] - Normalized per-token USD prices + free flag.
 * @property {object} [reasoning] - supported/mandatory/efforts/defaultEffort.
 * @property {object} [routing] - endpointIds/defaultEndpoint/languages/isModerated/catalogMatch.
 * @property {object} [parameters] - Supported request parameters (provider-declared booleans).
 * @property {{providerFields: number, inferredFields: number, unknownFields: number, quality: number}} metadataQuality
 * @property {string} [firstSeenAt] - Bookkeeping (day precision).
 * @property {string} [lastSeenAt] - Content-gated bookkeeping (day precision).
 * @property {number} [absentStreak] - Consecutive healthy-run absences; prune at 3.
 * @property {string} [tier] - 'standard' | 'fallback' | 'premium' | 'free'.
 * @property {{source: string, id: string, preferred: boolean, tier: string|null}[]} [routes]
 *   All providers serving this canonicalKey; SOURCE_PRIORITY marks the preferred route.
 * @property {object} [raw] - Trimmed provider payload (dropped over the KV size soft limit).
 * @property {object} [local] - Manual/offline execution facts (url, size, ram, chatFormat...).
 */

/**
 * The models list document stored in KV key "list" and served at /models.
 * @typedef {object} ModelsDocument
 * @property {string} last_syncer_run
 * @property {ProducersData} producers - Legacy Company -> Series -> Model tree.
 * @property {ProducersData} fallback - Free-tier fallback tree (OpenRouter :free).
 * @property {CortexModel[]} [catalog] - Additive canonical catalog (catalog standardization).
 * @property {string} version
 */


// This export is just to satisfy the module system, as this file only contains type definitions.
export {};