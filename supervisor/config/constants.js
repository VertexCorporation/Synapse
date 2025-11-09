/*
 * Cortex Supervisor Worker - Constants
 * Defines core constants, default settings, and processing statuses.
 */

// Default configuration values, used if environment variables are not set.
export const DEFAULTS = {
    TARGET_LANGUAGES: "tr,fr,zh",
    SERIES_DESC_EN_MIN_LENGTH: 40,
    SERIES_DESC_EN_MAX_LENGTH: 160,
    SERIES_DESC_GENERATION_TIMEOUT_MS: 35000,
    SERIES_DESC_EN_GENERATION_RETRIES: 3,
    TRANSLATION_TIMEOUT_MS: 45000,
    LOCK_TTL_S: 300,
    PROCESSING_CHUNK_SIZE: 4,
    MAX_SUPERVISOR_CONFLICT_RETRIES: 3,
    MAX_API_CALL_RETRIES_PER_MODEL_ACTION: 2,
    MAX_API_FAILURES_PER_MODEL_IN_TASK: 2,
    MAX_TOTAL_API_FAILURES_MODEL_IN_RUN: 3,
    MAX_CUMULATIVE_FAILURES_PER_ITEM: 5,
    PERSISTENT_BLACKLIST_TTL_S: 3600,
    PERSISTENT_FAILURE_COUNT_TTL_S: 3600,
    // Thresholds for the cleanup endpoint
    CORRUPTED_SERIES_EN_DESC_THRESHOLD: 200,
    CORRUPTED_SERIES_TRANSLATION_THRESHOLD: 200,
    CORRUPTED_VARIANT_TRANSLATION_THRESHOLD: 2000,
    // AI Prompt for generating series descriptions
    SERIES_DESC_GENERATION_PROMPT: `You are an AI assistant tasked with creating a very concise and informative description for a series of AI models.
Given Producer: "{PRODUCER_NAME}" and Series: "{SERIES_NAME}".
Generate a single, compelling English sentence.
This description MUST be between 40 and {MAX_LENGTH} characters long.
Focus on the series' general purpose or key characteristic. Avoid redundancy.
Example for "OpenAI / ChatGPT": "Versatile conversational AI for a wide range of tasks."
Concise English Description (40-{MAX_LENGTH} chars):`,
};

// External API endpoints
export const API_URLS = {
    OPENROUTER: 'https://openrouter.ai/api/v1/chat/completions',
    GOOGLE_TRANSLATE: 'https://translation.googleapis.com/language/translate/v2',
};

// Standardized processing status constants used throughout the worker
export const STATUS = {
    NOT_PROCESSED: 'not_processed',
    GENERATED: 'generated',
    COMPLETED: 'completed',
    TRANSLATION_RETRY: 'translation_retry',
    FAILED: 'FAILED',
    // New status for manual/admin corrections
    VERIFIED: 'verified',
    AUDITED_CORRECTED: 'audited_corrected',
};