/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Configuration
 * Description: Centralized configuration and constants for the Syncer Worker.
 * All static values, thresholds, and mappings are defined here for easy management.
 */

/**
 * Default settings for various operations. Can be overridden by environment variables.
 */
export const DEFAULTS = {
    COST_LIMIT: 0.000005,
    FETCH_TIMEOUT_MS: 60000, // 60 seconds
    CACHE_TTL_S: 3600, // 1 hour
    STALE_TTL_S: 86400, // 24 hours
    LOCK_TTL_S: 600, // 10 minutes (KV minimum is 60s)
    MANUAL_URL_CHECK_TIMEOUT_MS: 5000, // 5 seconds
};

/**
 * API endpoint for fetching model data.
 */
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/**
 * Pricing thresholds for categorizing models into tiers.
 */
export const TIER_THRESHOLDS = {
    TEXT_PREMIUM: 0.0000007,
    IMAGE_PREMIUM: 0.00001,
};

/**
 * A mapping of provider IDs from the API to their desired display names.
 * This also acts as a whitelist for which providers to process.
 */
export const PRODUCER_MAP = {
    google: "Google",
    "meta-llama": "Meta",
    openai: "OpenAI",
    qwen: "Qwen",
    deepseek: "DeepSeek",
    microsoft: "Microsoft",
    mistralai: "Mistral AI",
    "x-ai": "xAI",
    anthropic: "Anthropic",
    nousresearch: "NousResearch",
    cohere: "Cohere",
    amazon: "Amazon",
    perplexity: "Perplexity",
    "arcee-ai": "Arcee AI"
};

/**
 * An array of provider IDs derived from the PRODUCER_MAP.
 * Used to filter models from the API response.
 */
export const ALLOWED_PROVIDER_IDS = Object.keys(PRODUCER_MAP);

/**
 * Cost limits for filtering out models that are too expensive.
 */
export const TEXT_COST_LIMIT = +(DEFAULTS.COST_LIMIT);
export const IMAGE_COST_LIMIT = 0.0001;