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
    COST_LIMIT: 0.00001,
    FETCH_TIMEOUT_MS: 60000, // 60 seconds
    CACHE_TTL_S: 3600, // 1 hour
    STALE_TTL_S: 86400, // 24 hours
    LOCK_TTL_S: 600, // 10 minutes (KV minimum is 60s)
    MANUAL_URL_CHECK_TIMEOUT_MS: 5000, // 5 seconds
    HF_DISCOVERY_CANDIDATES: 2000, // Bounded popular candidate pool per hourly run
    HF_DISCOVERY_REPOS: 24, // At most 24 detailed repository requests
    HF_FETCH_TIMEOUT_MS: 15000, // 15 seconds per HuggingFace repo lookup
    HF_MAX_CONCURRENT_REPOS: 6, // Parallel HF Hub API calls per sync run
};

/**
 * API endpoints for fetching model data.
 */
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
export const FAL_URL = "https://api.fal.ai/v1/models";
export const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/models";
export const DEEPGRAM_URL = "https://api.deepgram.com/v1/models";
export const GROQ_URL = "https://api.groq.com/openai/v1/models";

/**
 * Provider priority for deduplication:
 * groq > cloudflare > openrouter > fal > elevenlabs > deepgram
 */
export const SOURCE_PRIORITY = Object.freeze({
    groq: 6,
    cloudflare: 5,
    openrouter: 4,
    fal: 3,
    elevenlabs: 2,
    deepgram: 1,
});

/**
 * Base endpoint for the HuggingFace Hub Models API, used to refresh
 * live file size / popularity / license metadata for offline (GGUF) models.
 */
export const HUGGINGFACE_API_BASE = "https://huggingface.co/api/models";


/**
 * A mapping of provider IDs from the API to their desired display names.
 * This also acts as a whitelist for which providers to process.
 */
export const PRODUCER_MAP = {
    google: "Google",
    "meta-llama": "Meta",
    meta: "Meta",
    openai: "OpenAI",
    qwen: "Qwen",
    deepseek: "DeepSeek",
    microsoft: "Microsoft",
    mistralai: "Mistral AI",
    mistral: "Mistral AI",
    "x-ai": "xAI",
    anthropic: "Anthropic",
    nousresearch: "NousResearch",
    cohere: "Cohere",
    amazon: "Amazon",
    perplexity: "Perplexity",
    "arcee-ai": "Arcee AI",
    "moonshotai": "Moonshot AI",
    "nvidia": "NVIDIA",
    "inclusionai": "inclusionAI",
    "z-ai": "Z.AI",
    "liquid": "Liquid AI",
    "ibm-granite": "IBM",
    "fal": "Fal AI",
    "fal-ai": "Fal AI",
    "elevenlabs": "ElevenLabs",
    "deepgram": "Deepgram",
    "cloudflare": "Cloudflare",
    "groq": "Groq",
    "blackforestlabs": "Black Forest Labs",
    "kling": "Kling",
    "minimax": "MiniMax",
    "recraft": "Recraft",
    "ideogram": "Ideogram",
    "luma": "Luma AI",
    "bytedance": "ByteDance",
    "wan": "Wan",
    "alibaba": "Wan",
    "pixverse": "PixVerse",
    "stability": "Stability AI",
    "stabilityai": "Stability AI",
    "bria": "Bria",
    "topaz": "Topaz",
    "runway": "Runway",
    "vidu": "Vidu",
    "tencent": "Tencent",
    "hunyuan": "Tencent",
    "kokoro": "Kokoro",
    "lightricks": "Lightricks",
    "meshy": "Meshy",
    "tripo3d": "Tripo3D",
    "playht": "PlayHT"
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
export const IMAGE_COST_LIMIT = 0.07;
export const WEB_SEARCH_COST_LIMIT = 0.07;