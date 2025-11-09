/*
 * Cortex Supervisor Worker - Settings Loader
 * Reads and sanitizes configuration from environment variables, falling back to defaults.
 */
import { DEFAULTS } from './constants.js';

/**
 * Creates a centralized settings object from environment variables and defaults.
 * This makes accessing configuration cleaner and safer throughout the application.
 * @param {object} env - The worker's environment object.
 * @returns {object} A configuration object with sanitized values.
 */
export function getSettings(env) {
    return {
        // --- Core Settings ---
        isVerboseLogging: env.VERBOSE_LOGGING === 'true',
        targetLanguages: (env.TARGET_LANGUAGES || DEFAULTS.TARGET_LANGUAGES)
            .split(',')
            .map(lang => lang.trim().toLowerCase())
            .filter(lang => lang && lang !== 'en'),
        processingChunkSize: +(env.PROCESSING_CHUNK_SIZE || DEFAULTS.PROCESSING_CHUNK_SIZE),
        lockTtlSeconds: +(env.LOCK_TTL_S || DEFAULTS.LOCK_TTL_S),
        maxConflictRetries: +(env.MAX_SUPERVISOR_CONFLICT_RETRIES || DEFAULTS.MAX_SUPERVISOR_CONFLICT_RETRIES),

        // --- API Keys (essential) ---
        openRouterApiKey: env.OPENROUTER_KEY,
        googleTranslateApiKey: env.GOOGLE_TRANSLATE_API_KEY,
        supervisorApiKey: env.SUPERVISOR_API_KEY,

        // --- OpenRouter Specific Settings ---
        openRouterReferer: env.OPENROUTER_REFERER || 'https://cortex-supervisor.app.com',
        openRouterTitle: env.OPENROUTER_TITLE || 'Cortex Supervisor Worker',

        // --- AI Generation Task Settings ---
        seriesDescPrompt: env.SERIES_DESC_GENERATION_PROMPT || DEFAULTS.SERIES_DESC_GENERATION_PROMPT,
        seriesDescMinLength: +(env.SERIES_DESC_EN_MIN_LENGTH || DEFAULTS.SERIES_DESC_EN_MIN_LENGTH),
        seriesDescMaxLength: +(env.SERIES_DESC_EN_MAX_LENGTH || DEFAULTS.SERIES_DESC_EN_MAX_LENGTH),
        seriesDescTimeoutMs: +(env.SERIES_DESC_GENERATION_TIMEOUT_MS || DEFAULTS.SERIES_DESC_GENERATION_TIMEOUT_MS),
        seriesDescRetries: +(env.SERIES_DESC_EN_GENERATION_RETRIES || DEFAULTS.SERIES_DESC_EN_GENERATION_RETRIES),

        // --- Translation Task Settings ---
        translationTimeoutMs: +(env.TRANSLATION_TIMEOUT_MS || DEFAULTS.TRANSLATION_TIMEOUT_MS),
        
        // --- Failure Handling & Blacklisting Settings ---
        maxApiCallRetries: +(env.MAX_API_CALL_RETRIES_PER_MODEL_ACTION || DEFAULTS.MAX_API_CALL_RETRIES_PER_MODEL_ACTION),
        maxApiFailuresPerModelInTask: +(env.MAX_API_FAILURES_PER_MODEL_IN_TASK || DEFAULTS.MAX_API_FAILURES_PER_MODEL_IN_TASK),
        maxTotalApiFailuresInRun: +(env.MAX_TOTAL_API_FAILURES_MODEL_IN_RUN || DEFAULTS.MAX_TOTAL_API_FAILURES_MODEL_IN_RUN),
        maxCumulativeFailuresPerItem: +(env.MAX_CUMULATIVE_FAILURES_PER_ITEM || DEFAULTS.MAX_CUMULATIVE_FAILURES_PER_ITEM),
        persistentBlacklistTtlSeconds: +(env.PERSISTENT_BLACKLIST_TTL_S || DEFAULTS.PERSISTENT_BLACKLIST_TTL_S),
        persistentFailureCountTtlSeconds: +(env.PERSISTENT_FAILURE_COUNT_TTL_S || DEFAULTS.PERSISTENT_FAILURE_COUNT_TTL_S),

        // --- Cleanup Endpoint Thresholds ---
        cleanupThresholds: {
            seriesEn: +(env.CORRUPTED_SERIES_EN_DESC_THRESHOLD || DEFAULTS.CORRUPTED_SERIES_EN_DESC_THRESHOLD),
            seriesTranslation: +(env.CORRUPTED_SERIES_TRANSLATION_THRESHOLD || DEFAULTS.CORRUPTED_SERIES_TRANSLATION_THRESHOLD),
            variantTranslation: +(env.CORRUPTED_VARIANT_TRANSLATION_THRESHOLD || DEFAULTS.CORRUPTED_VARIANT_TRANSLATION_THRESHOLD),
        }
    };
}