/*
 * Cortex Supervisor Worker - Status Endpoint Handler
 * Generates and returns a system status report.
 */
import { STATUS, DEFAULTS } from '../../config/constants.js';

/**
 * Generates a system status report for observability.
 * @param {object} modelsKv The MODELS_JSON KV namespace.
 * @param {object} locksKv The LOCKS KV namespace.
 * @param {object} settings The application settings object.
 * @returns {Promise<object>} A status report object.
 */
export async function generateSystemStatus(modelsKv, locksKv, settings) {
    const [listStr, supervisorLock, syncerLock] = await Promise.all([
        modelsKv.get('list'),
        locksKv.get('supervisor_lock'),
        locksKv.get('syncer_lock')
    ]);

    if (!listStr) {
        return { status: "error", message: "Models list not found in KV." };
    }

    const data = JSON.parse(listStr);
    let pendingTranslationTasks = 0;
    let permanentlyFailed = 0;

    const PENDING_STATUSES = new Set([
        STATUS.NOT_PROCESSED,
        STATUS.TRANSLATION_RETRY,
        STATUS.GENERATED,
        undefined,
        null
    ]);
    const FAILED_STATUSES = new Set([STATUS.FAILED]); // Simplified, as we don't use PERMANENTLY_FAILED

    for (const p of Object.values(data.producers || {})) {
        for (const s of Object.values(p)) {
            // Series Descriptions
            if (s.series_description?.en) {
                if (PENDING_STATUSES.has(s.series_description.processing_status?.en)) pendingTranslationTasks++;
                if (FAILED_STATUSES.has(s.series_description.processing_status?.en)) permanentlyFailed++;
                for (const lang of settings.targetLanguages) {
                    if (!s.series_description[lang] || PENDING_STATUSES.has(s.series_description.processing_status?.[lang])) pendingTranslationTasks++;
                    if (FAILED_STATUSES.has(s.series_description.processing_status?.[lang])) permanentlyFailed++;
                }
            }
            
            // Variants (Online & Manual)
            for (const vName in s) {
                if (vName === 'series_description') continue;
                const variant = s[vName];
                if (variant?.description?.en) { // Online
                    for (const lang of settings.targetLanguages) {
                         if (!variant.description[lang] || PENDING_STATUSES.has(variant.description.processing_status?.[lang])) pendingTranslationTasks++;
                         if (FAILED_STATUSES.has(variant.description.processing_status?.[lang])) permanentlyFailed++;
                    }
                } else if (variant?.source === 'manual' && variant.details?.en) { // Manual
                    const fields = ['title', 'summary', 'description', 'role'];
                    for (const lang of settings.targetLanguages) {
                         for (const field of fields) {
                            if (!variant.details.en[field]) continue;
                            const status = variant.details.processing_status?.[lang]?.[field];
                            if (!variant.details[lang]?.[field] || PENDING_STATUSES.has(status)) pendingTranslationTasks++;
                            if (FAILED_STATUSES.has(status)) permanentlyFailed++;
                        }
                    }
                }
            }
        }
    }

    return {
        status: "ok",
        lastSupervisorUpdate: data.last_supervisor_update_ts || "N/A",
        lastSupervisorRunId: data.last_supervisor_run || "N/A",
        lockStatus: `Supervisor: ${supervisorLock || 'Unlocked'} | Syncer: ${syncerLock || 'Unlocked'}`,
        pendingTranslationTasks,
        permanentlyFailedTasks: permanentlyFailed,
        timestamp: new Date().toISOString()
    };
}