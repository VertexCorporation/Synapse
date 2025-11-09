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
 * @property {('openrouter'|'manual')} source - The origin of the model data.
 * @property {string} tier - The pricing tier ('free', 'premium').
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


// This export is just to satisfy the module system, as this file only contains type definitions.
export {};