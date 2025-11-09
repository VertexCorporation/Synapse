/*
 * Cortex Supervisor Worker - Main Orchestrator
 * This is the core logic that runs on a schedule. It finds and processes tasks,
 * applying a retry-on-conflict strategy for data consistency.
 */
import { getSettings } from '../config/settings.js';
import { createLogger } from '../utils/logger.js';
import { noopKV, selectRandomElement } from '../utils/helpers.js';
import { acquireLock, releaseLock, getLockHolder } from '../kv/lock.js';
import { readModelsData, writeModelsData } from '../kv/data.js';
import { generateSeriesEnglishDescription } from '../api/openrouter.js';
import { performPrimaryTranslation } from '../api/translate.js';
import { findSeriesForDescriptionGeneration, findTranslationTasks } from '../logic/find.js';
import { attemptApiCallWithRetries } from './task.js';
import { STATUS } from '../config/constants.js';

/**
 * The main scheduled event handler for the Supervisor worker.
 * @param {object} env The worker's environment object.
 * @param {object} context The execution context.
 */
export async function handleScheduled(env, context) {
    const opId = `supervisor-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const settings = getSettings(env);
    const logger = createLogger(settings.isVerboseLogging, opId);

    logger.info(`🚀 SUPERVISOR MISSION START (Modular v1.0)`);
    
    const locksKv = env.LOCKS ?? noopKV;
    const modelsKv = env.MODELS_JSON;
    const lockKey = "supervisor_lock";

    // Prevent run if maintenance/cleanup is active
    const cleanupHolder = await getLockHolder(locksKv, "cleanup_lock");
    if (cleanupHolder) {
        logger.warn(`🔶 Cleanup process is running (Lock held by: ${cleanupHolder}). Supervisor is yielding.`);
        return;
    }

    const lockAcquired = await acquireLock(locksKv, lockKey, opId, settings.lockTtlSeconds, logger);
    if (!lockAcquired) {
        logger.info(`[MAIN] Could not acquire lock "${lockKey}". Terminating this run.`);
        return;
    }

    try {
        await runMainProcessingLoop(modelsKv, locksKv, settings, logger, opId);
    } catch (e) {
        logger.error(`💥 FATAL UNHANDLED ERROR in main loop: ${e.name} - ${e.message}`, e.stack);
        throw e;
    } finally {
        context.waitUntil(releaseLock(locksKv, lockKey, logger));
        logger.debug(`🏁 SUPERVISOR MISSION CONCLUDED.`);
    }
}

/**
 * The core processing loop with retry-on-conflict logic.
 */
async function runMainProcessingLoop(modelsKv, locksKv, settings, logger, opId) {
    for (let attempt = 1; attempt <= settings.maxConflictRetries; attempt++) {
        logger.info(`\n============== Starting Processing Attempt #${attempt}/${settings.maxConflictRetries} ==============`);

        const { data: currentData, version: initialVersion } = await readModelsData(modelsKv);
        if (!currentData) {
            logger.warn(`[MAIN] Attempt #${attempt}: 'list' not found in KV. Nothing to process.`);
            return;
        }
        logger.debug(`[MAIN] Attempt #${attempt}: Read model list. Version: ${initialVersion}`);

        // The state object to be mutated by processing functions
        let processingState = {
            data: currentData,
            changesMade: false,
            isTranslationApiDisabled: false
        };

        // --- PHASE 0: AI SERIES DESCRIPTION GENERATION ---
        await processSeriesDescriptionTasks(processingState, settings, logger, opId, locksKv);

        // --- PHASE 1: TRANSLATION ---
        await processTranslationTasks(processingState, settings, logger, opId, locksKv);

        // --- STAGE 3: SAVE CHANGES ---
        if (processingState.changesMade) {
            const currentVersionInKV = await modelsKv.get('version');
            if (currentVersionInKV !== initialVersion) {
                logger.warn(`🔶 Attempt #${attempt}: VERSION CONFLICT! Stale: ${initialVersion}, Current: ${currentVersionInKV}.`);
                if (attempt < settings.maxConflictRetries) {
                    const waitMs = 250 * Math.pow(2, attempt);
                    logger.debug(` -> Discarding changes and retrying in ${waitMs}ms...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue; // Continue to the next iteration of the loop
                } else {
                    logger.error(`❌ Max retries (${settings.maxConflictRetries}) reached on version conflict. Aborting.`);
                    break; // Exit the loop
                }
            } else {
                logger.debug(`✍️ Attempt #${attempt}: No version conflict. Saving updated data...`);
                const newVersion = await writeModelsData(modelsKv, processingState.data, opId);
                logger.debug(`✅ KV successfully updated. New Version: ${newVersion}. Mission complete.`);
                return; // Success, exit function
            }
        } else {
            logger.debug(`⚖️ Attempt #${attempt}: No changes made. Mission complete.`);
            return; // Success, exit function
        }
    }
}


/**
 * Processes series description generation tasks.
 */
async function processSeriesDescriptionTasks(state, settings, logger, opId, locksKv) {
    logger.debug(`\n== STARTING PHASE 0: AI SERIES DESCRIPTION GENERATION ==\n`);
    const tasks = findSeriesForDescriptionGeneration(state.data);
    const chunk = tasks.slice(0, settings.processingChunkSize);
    
    if (chunk.length > 0) {
        const allModelCandidateIds = Object.values(state.data.producers).flatMap(p => Object.values(p).flatMap(s => Object.values(s).filter(v => v?.source === 'openrouter').map(v => v.id)));
        const modelApiFailuresForThisGenTask = {};

        for (const { pName, sName } of chunk) {
            const seriesIdentifier = `${pName}/${sName}`;
            let generatedSuccessfully = false;
            
            for (let genAttempt = 0; genAttempt < settings.seriesDescRetries && !generatedSuccessfully; genAttempt++) {
                let availableModels = allModelCandidateIds.filter(id => (modelApiFailuresForThisGenTask[`${id}-${seriesIdentifier}-SeriesDescGeneration`] || 0) < settings.maxApiFailuresPerModelInTask);
                const genModelId = selectRandomElement(availableModels);
                if (!genModelId) {
                    logger.warn(`[DESC_GEN] No models left for series EN desc gen for ${seriesIdentifier}.`);
                    break;
                }

                const context = { settings, logger, opId, locksKv, modelApiFailuresPerTask: modelApiFailuresForThisGenTask };
                const apiCallArgs = [pName, sName, genModelId, settings, logger, opId];
                const result = await attemptApiCallWithRetries(generateSeriesEnglishDescription, apiCallArgs, genModelId, seriesIdentifier, "SeriesDescGeneration", context);
                
                if (result.success && result.result) {
                    const seriesDesc = state.data.producers[pName][sName].series_description;
                    seriesDesc.en = result.result;
                    seriesDesc.processing_status.en = STATUS.GENERATED;
                    state.changesMade = true;
                    generatedSuccessfully = true;
                    logger.info(`✅ [DESC_GEN] Generated EN desc for ${seriesIdentifier} with ${genModelId}.`);
                }
            }
             if (!generatedSuccessfully) logger.error(`❌ [DESC_GEN] FAILED to generate EN series description for ${seriesIdentifier}.`);
        }
    }
     logger.debug(`--- Finished PHASE 0 ---`);
}


/**
 * Processes translation tasks.
 */
async function processTranslationTasks(state, settings, logger, opId, locksKv) {
    logger.debug(`\n== STARTING PHASE 1: TRANSLATION ==\n`);
    const tasks = findTranslationTasks(state.data, settings.targetLanguages);
    const chunk = tasks.slice(0, settings.processingChunkSize);
    
    for (const task of chunk) {
        const taskIdentifier = `${task.type}-${task.pName.replace(/\//g, '_')}-${task.sName.replace(/\//g, '_')}-${(task.vName || 'series').replace(/\//g, '_')}-${task.lang}-${task.textType}`;
        if (state.isTranslationApiDisabled) {
             logger.debug(`Skipping task ${taskIdentifier} as translation API is disabled for this run.`);
             continue;
        }
        
        try {
            // ... (The large try/catch block from the original file's PHASE 1 for loop goes here)
            // This logic is complex and specific to this loop, so keeping it here is clearer.
            // We find the target object, call the API, and update the state.
            // Example for translation success:
            // if (translationAttempt.success) {
            //     targetObject[targetField] = translationAttempt.result;
            //     ...
            //     state.changesMade = true;
            // }
            // Example for API disabled error:
            // if (error?.status === 403) {
            //     state.isTranslationApiDisabled = true;
            //     continue;
            // }
            // ... [This part is very long, so I'm summarizing it, but it's a direct copy-paste]
             // --- The logic below is a direct adaptation from the original file ---
            let targetObject, statusObject, targetField, statusField, hashField;

            // 1. Locate the target objects in the main data structure
            if (task.type === 'manual') {
                const details = state.data.producers[task.pName][task.sName][task.vName].details;
                details[task.lang] ??= {};
                targetObject = details[task.lang];
                details.processing_status[task.lang] ??= {};
                statusObject = details.processing_status[task.lang];
                targetField = task.textType;
                statusField = task.textType;
                hashField = `${task.textType}_source_hash`;
                if (statusObject[hashField] !== task.sourceHash) delete targetObject[targetField];
            } else if (task.type === 'series') {
                targetObject = state.data.producers[task.pName][task.sName].series_description;
                statusObject = targetObject.processing_status;
                targetField = task.lang; statusField = task.lang; hashField = `${task.lang}_source_hash`;
            } else { // 'variant'
                targetObject = state.data.producers[task.pName][task.sName][task.vName].description;
                statusObject = targetObject.processing_status;
                targetField = task.lang; statusField = task.lang; hashField = `${task.lang}_source_hash`;
            }

            // 2. Handle English verification task (special case)
            if (task.lang === 'en' && statusObject.en === STATUS.GENERATED) {
                statusObject.en = STATUS.COMPLETED;
                state.changesMade = true;
                continue;
            }

            // 3. Perform the translation API call
            const context = { settings, logger, opId, locksKv, modelApiFailuresPerTask: {} };
            const apiCallArgs = [task.englishText, task.lang, settings, logger, opId];
            const result = await attemptApiCallWithRetries(performPrimaryTranslation, apiCallArgs, 'google-translate-api', taskIdentifier, "PrimaryTranslation", context);

            // 4. Update state based on the result
            if (result.success && result.result) {
                targetObject[targetField] = result.result;
                statusObject[statusField] = STATUS.COMPLETED;
                statusObject[hashField] = task.sourceHash;
                statusObject.cumulativeFailureCount = 0; // Reset on success
                state.changesMade = true;
            } else {
                 if (result.error?.status === 403 && result.error.message?.includes("Cloud Translation API")) {
                    logger.warn(`🔶 Detected that Google Translate API is disabled (403). Halting translation tasks.`);
                    state.isTranslationApiDisabled = true;
                    continue;
                }
                logger.error(`❌ [TRANSLATE] Task ${taskIdentifier} failed. Error: ${result.error?.message || 'Unknown'}`);
                const currentStatus = statusObject[statusField];
                statusObject[statusField] = (currentStatus === STATUS.TRANSLATION_RETRY) ? STATUS.FAILED : STATUS.TRANSLATION_RETRY;
                statusObject.cumulativeFailureCount = (statusObject.cumulativeFailureCount || 0) + 1;
                state.changesMade = true;
            }

            if ((statusObject.cumulativeFailureCount || 0) >= settings.maxCumulativeFailuresPerItem) {
                logger.warn(`🚫 [TRANSLATE] Task ${taskIdentifier} reached max failures. Marking as FAILED.`);
                statusObject[statusField] = STATUS.FAILED;
                statusObject[hashField] = task.sourceHash;
                state.changesMade = true;
            }
            
        } catch (e) {
            logger.error(`💥 [POISON_PILL_CAUGHT] Unrecoverable error processing task ${taskIdentifier}. Error: ${e.message}`, e.stack);
        }
    }
    logger.debug(`--- Finished PHASE 1 ---`);
}