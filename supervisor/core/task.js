/*
 * Cortex Supervisor Worker - Task Runner Engine
 * Provides a robust, generic engine for executing API calls with retries,
 * error handling, and persistent blacklisting logic.
 */

/**
 * Attempts to execute a given API call function with a configurable number of retries.
 * Handles transient errors, client errors, and tracks failures for blacklisting.
 * @param {Function} apiCallFunction The async function to execute.
 * @param {Array} argsArray The array of arguments to pass to the function.
 * @param {string} modelId The identifier for the resource being used (e.g., an AI model ID).
 * @param {string} taskIdentifier A unique string identifying the specific task being performed.
 * @param {string} actionType A descriptive name for the action (e.g., "SeriesDescGeneration").
 * @param {object} context An object containing { env, settings, logger, opId, locksKv, modelApiFailuresPerTask }.
 * @returns {Promise<{success: boolean, result?: any, error?: Error, errorType?: string, modelId: string}>}
 */
export async function attemptApiCallWithRetries(
    apiCallFunction,
    argsArray,
    modelId,
    taskIdentifier,
    actionType,
    context
) {
    const { settings, logger, opId, locksKv, modelApiFailuresPerTask } = context;

    const maxRetries = settings.maxApiCallRetries;
    const modelFailuresInTaskLimit = settings.maxApiFailuresPerModelInTask;
    const modelTotalFailuresInRunLimit = settings.maxTotalApiFailuresInRun;
    const blacklistTtl = settings.persistentBlacklistTtlSeconds;
    const failureCountTtl = settings.persistentFailureCountTtlSeconds;

    const modelSpecificTaskFailuresKey = `${modelId}-${taskIdentifier}-${actionType}`;
    modelApiFailuresPerTask[modelSpecificTaskFailuresKey] = modelApiFailuresPerTask[modelSpecificTaskFailuresKey] || 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // --- Persistent Blacklist Check ---
        const blacklistKey = `blacklist:${modelId}`;
        const isBlacklisted = await locksKv.get(blacklistKey);
        if (isBlacklisted) {
            logger.debug(`[${opId}] Task (${taskIdentifier}): Model ${modelId} is on persistent blacklist. Skipping.`);
            return { success: false, errorType: "blacklisted_persistent", modelId };
        }
        
        // --- Task-Specific Failure Check ---
        if (modelApiFailuresPerTask[modelSpecificTaskFailuresKey] >= modelFailuresInTaskLimit) {
            logger.debug(`[${opId}] Task (${taskIdentifier}): Model ${modelId} reached max task failures. Skipping.`);
            return { success: false, errorType: "blacklisted_task_action", modelId };
        }

        logger.info(`[${opId}] Task (${taskIdentifier}): ${actionType} attempt ${attempt}/${maxRetries} with model ${modelId}.`);
        try {
            const result = await apiCallFunction(...argsArray);
            return { success: true, result, modelId };
        } catch (e) {
            logger.warn(`⚠️ [${opId}] Task (${taskIdentifier}): attempt ${attempt} with ${modelId} FAILED: ${e.message}`);
            
            // Unrecoverable client errors (4xx but not 429) should not be retried.
            if (e.isApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
                logger.error(`❌ [${opId}] Unrecoverable client error (Status: ${e.status}) for ${modelId}. Aborting retries.`);
                return { success: false, errorType: "client_error", error: e, modelId };
            }

            modelApiFailuresPerTask[modelSpecificTaskFailuresKey]++;

            // --- Persistent Failure Counting ---
            const totalFailuresKey = `failures:${modelId}`;
            const failureCountStr = await locksKv.get(totalFailuresKey);
            let currentTotalFailures = (parseInt(failureCountStr, 10) || 0) + 1;
            
            await locksKv.put(totalFailuresKey, currentTotalFailures.toString(), { expirationTtl: failureCountTtl });

            if (currentTotalFailures >= modelTotalFailuresInRunLimit) {
                 logger.warn(`🚫 [${opId}] MODEL BLACKLISTED (PERSISTENT): ${modelId} for ${blacklistTtl}s due to ${currentTotalFailures} total API failures.`);
                 await locksKv.put(blacklistKey, "true", { expirationTtl: blacklistTtl });
            }
            
            if (attempt >= maxRetries) {
                logger.error(`❌ [${opId}] All ${maxRetries} API attempts for ${actionType} with ${modelId} failed.`);
                return { success: false, errorType: "max_retries_exceeded", error: e, modelId };
            }
            if (e.isConfigError) {
                logger.error(`❌ [${opId}] Config error with ${modelId}. Aborting retries.`);
                return { success: false, errorType: "config_error", error: e, modelId };
            }
            // Exponential backoff for retries
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }
    // This should ideally not be reached, but serves as a fallback.
    return { success: false, errorType: "unknown_retry_failure", modelId };
}