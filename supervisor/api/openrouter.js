/*
 * Cortex Supervisor Worker - OpenRouter API Client
 * Manages all interactions with the OpenRouter.ai API for model operations.
 */
import { API_URLS } from '../config/constants.js';
import { fetchWithTimeout } from '../utils/helpers.js';

/**
 * A generic function to call an AI model via the OpenRouter API.
 * @param {string} prompt The user prompt.
 * @param {string} modelId The ID of the model to use (e.g., "openai/gpt-4").
 * @param {object} settings A configuration object containing API keys and options.
 * @param {object} logger A logger instance.
 * @param {string} operationId A unique ID for logging this specific operation.
 * @returns {Promise<string|null>} The content of the AI's response, or null if empty.
 */
async function callAIModel(prompt, modelId, settings, logger, operationId) {
    logger.info(`📞 [${operationId}] Calling AI: ${modelId}. Timeout: ${settings.seriesDescTimeoutMs}ms.`);

    if (modelId.includes('/') && !settings.openRouterApiKey) {
        logger.error(`💥 [${operationId}] CONFIG ERROR: OPENROUTER_KEY missing for model "${modelId}".`);
        const keyError = new Error('OPENROUTER_KEY missing.');
        keyError.isConfigError = true;
        throw keyError;
    }

    try {
        const response = await fetchWithTimeout(
            API_URLS.OPENROUTER,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.openRouterApiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': settings.openRouterReferer,
                    'X-Title': settings.openRouterTitle,
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: settings.seriesDescMaxLength + 50,
                    temperature: 0.75,
                }),
            },
            settings.seriesDescTimeoutMs,
            operationId,
            modelId,
            logger
        );

        if (!response.ok) {
            let errTxt = `Status: ${response.status}`;
            try { const eBody = await response.json(); errTxt += `, Body: ${JSON.stringify(eBody).slice(0, 300)}`; }
            catch (e) { errTxt += `, Raw Body: ${(await response.text()).slice(0, 300)}`; }
            logger.error(`❌ [${operationId}] API call FAILED for model ${modelId}. ${errTxt}`);
            const apiError = new Error(`API Error (Model: ${modelId}): ${errTxt}`);
            apiError.status = response.status;
            apiError.isApiError = true;
            throw apiError;
        }

        const result = await response.json();
        const content = result?.choices?.[0]?.message?.content?.trim();

        if (!content) {
            logger.warn(`⚠️ [${operationId}] AI (Model: ${modelId}) returned EMPTY content.`);
            const emptyError = new Error('AI returned empty content.');
            emptyError.isEmptyResponse = true;
            throw emptyError;
        }
        
        logger.info(`💬 [${operationId}] AI (${modelId}) responded. Length: ${content.length}.`);
        return content;

    } catch (e) {
        // Re-throw the original error with added context if needed, but fetchWithTimeout already logs well.
        e.modelId = e.modelId || modelId;
        e.role = e.role || "ai_call";
        throw e;
    }
}

/**
 * Generates an English description for a model series using a specified AI model.
 * @param {string} producerName The name of the model's producer.
 * @param {string} seriesName The name of the model series.
 * @param {string} generationModelId The model ID to use for generating the description.
 * @param {object} settings The application settings object.
 * @param {object} logger A logger instance.
 * @param {string} opId The parent operation ID for logging.
 * @returns {Promise<string>} The generated description.
 * @throws {Error} if the generated description is invalid or generation fails.
 */
export async function generateSeriesEnglishDescription(producerName, seriesName, generationModelId, settings, logger, opId) {
    const operationId = `${opId}-gen-en-${producerName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const { seriesDescMinLength, seriesDescMaxLength, seriesDescPrompt } = settings;

    const prompt = seriesDescPrompt
        .replace('{PRODUCER_NAME}', producerName)
        .replace('{SERIES_NAME}', seriesName)
        .replace(/{MAX_LENGTH}/g, seriesDescMaxLength.toString());

    logger.debug(`[${operationId}] Generating EN series description for "${producerName}/${seriesName}" using ${generationModelId}. Target length: ${seriesDescMinLength}-${seriesDescMaxLength} chars.`);
    
    const description = await callAIModel(
        prompt,
        generationModelId,
        settings,
        logger,
        operationId
    );

    if (description && description.length >= seriesDescMinLength && description.length <= seriesDescMaxLength) {
        logger.info(`✅ [${operationId}] Generated valid EN series description (Len: ${description.length}).`);
        return description;
    }

    if (description) {
        logger.warn(`⚠️ [${operationId}] Generated EN desc (Len: ${description.length}) outside target range ${seriesDescMinLength}-${seriesDescMaxLength}. Discarding. Text: "${description.slice(0, 100)}"`);
        throw new Error(`Generated description length (${description.length}) is outside the target range.`);
    }
    
    throw new Error("Series description generation resulted in no usable text.");
}