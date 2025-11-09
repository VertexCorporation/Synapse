/*
 * Cortex Supervisor Worker - Google Translate API Client
 * Manages all interactions with the Google Cloud Translation API.
 */
import { API_URLS } from '../config/constants.js';
import { fetchWithTimeout } from '../utils/helpers.js';

/**
 * Translates a given text to a target language using the Google Translate API.
 * 
 * @param {string} englishText The source text in English.
 * @param {string} targetLangCode The two-letter language code (e.g., "tr", "fr").
 * @param {object} settings The application settings object, containing the API key and timeout values.
 * @param {object} logger A logger instance for structured logging.
 * @param {string} opId The parent operation ID for consistent logging.
 * @returns {Promise<string>} The translated text.
 * @throws {Error} Throws a custom error with properties (isConfigError, isApiError, isEmptyResponse) 
 *                 on failure, allowing for specific error handling upstream.
 */
export async function performPrimaryTranslation(englishText, targetLangCode, settings, logger, opId) {
    // Create a specific, detailed operation ID for this exact API call for better logging
    const operationId = `${opId}-gtranslate-to-${targetLangCode}`;
    const { googleTranslateApiKey, translationTimeoutMs } = settings;

    // 1. Pre-flight Check: Ensure the API key is configured.
    if (!googleTranslateApiKey) {
        logger.error(`💥 [${operationId}] CONFIGURATION ERROR: GOOGLE_TRANSLATE_API_KEY is missing from environment variables.`);
        const keyError = new Error('GOOGLE_TRANSLATE_API_KEY is missing.');
        keyError.isConfigError = true; // Add a flag for specific error handling
        throw keyError;
    }

    logger.info(`📞 [${operationId}] Calling Google Translate API for language: ${targetLangCode}.`);
    const GOOGLE_TRANSLATE_API_URL = `${API_URLS.GOOGLE_TRANSLATE}?key=${googleTranslateApiKey}`;

    try {
        // 2. Make the API call using our robust fetchWithTimeout helper.
        const response = await fetchWithTimeout(
            GOOGLE_TRANSLATE_API_URL,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ q: englishText, target: targetLangCode, format: 'text' }),
            },
            translationTimeoutMs,
            operationId,
            `gtranslate-${targetLangCode}`, // Log identifier
            logger
        );

        // 3. Handle non-successful HTTP responses.
        if (!response.ok) {
            let errorText = `Status: ${response.status}`;
            try {
                const errorBody = await response.json();
                errorText += `, Body: ${JSON.stringify(errorBody).slice(0, 200)}`;
            } catch (e) {
                // If the body is not JSON, try to read it as text.
                errorText += `, Raw Body: ${(await response.text()).slice(0, 200)}`;
            }
            logger.error(`❌ [${operationId}] Google Translate API call FAILED. ${errorText}`);
            const apiError = new Error(`Google Translate API Error: ${errorText}`);
            apiError.status = response.status;
            apiError.isApiError = true;
            throw apiError;
        }

        // 4. Parse the successful response and extract the translated text.
        const result = await response.json();
        const translatedText = result?.data?.translations?.[0]?.translatedText;

        // 5. Handle cases where the API returns a success status but no content.
        if (!translatedText) {
            logger.warn(`⚠️ [${operationId}] Google Translate API returned a successful response but with empty content for language ${targetLangCode}.`);
            const emptyError = new Error('Google Translate API returned empty content.');
            emptyError.isEmptyResponse = true;
            throw emptyError;
        }

        logger.info(`✅ [${operationId}] Google Translate successful. Preview: "${translatedText.slice(0, 50)}..."`);
        return translatedText;

    } catch (e) {
        // 6. Add context to any error thrown and re-throw it for the task runner to handle.
        e.role = `primary_translate_to_${targetLangCode}`;
        throw e;
    }
}