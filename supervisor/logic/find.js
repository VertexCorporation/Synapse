/*
 * Cortex Supervisor Worker - Task Finding Logic
 * Scans the main data object to identify items that need processing,
 * such as series description generation or translation.
 */
import { STATUS } from '../config/constants.js';
import { simpleHash } from '../utils/helpers.js';

/**
 * Finds all series that are missing an English description.
 * @param {Object} data The main models data object.
 * @returns {Array<Object>} An array of objects with { pName, sName } for each series.
 */
export function findSeriesForDescriptionGeneration(data) {
    const tasks = [];
    for (const pName in data.producers) {
        for (const sName in data.producers[pName]) {
            const seriesObj = data.producers[pName][sName];
            
            // Skip series that are just containers for a single "Default" manual model.
            const variantKeys = Object.keys(seriesObj).filter(key => key !== 'series_description');
            if (variantKeys.length === 1 && variantKeys[0] === 'Default') continue;

            // Ensure series_description object exists
            seriesObj.series_description ??= { processing_status: {} };
            
            if (!seriesObj.series_description.en) {
                tasks.push({ pName, sName });
            }
        }
    }
    return tasks;
}

/**
 * Finds all text items (descriptions, titles, etc.) that need translation or verification.
 * @param {Object} data The main models data object.
 * @param {Array<string>} targetLanguages An array of target language codes.
 * @returns {Array<Object>} A prioritized array of task objects.
 */
export function findTranslationTasks(data, targetLanguages) {
    const tasks = [];
    const COMPLETED_STATUSES = new Set([STATUS.COMPLETED, STATUS.FAILED]);

    for (const pName in data.producers) {
        for (const sName in data.producers[pName]) {
            const seriesObj = data.producers[pName][sName];

            // A) Series Descriptions
            if (seriesObj.series_description?.en) {
                const seriesDesc = seriesObj.series_description;
                seriesDesc.processing_status ??= {};
                const sourceHash = simpleHash(seriesDesc.en);

                // Task for "verifying" a newly generated English description
                if (seriesDesc.processing_status.en === STATUS.GENERATED) {
                    tasks.push({ type: 'series', pName, sName, lang: 'en', englishText: seriesDesc.en, sourceHash, currentStatus: seriesDesc.processing_status.en, textType: 'description' });
                }

                // Tasks for translating to other languages
                for (const lang of targetLanguages) {
                    const currentStatus = seriesDesc.processing_status[lang];
                    const storedHash = seriesDesc.processing_status[`${lang}_source_hash`];
                    if (!COMPLETED_STATUSES.has(currentStatus) || storedHash !== sourceHash) {
                        tasks.push({ type: 'series', pName, sName, lang, englishText: seriesDesc.en, sourceHash, textType: 'description', currentStatus, isStale: storedHash !== sourceHash });
                    }
                }
            }

            // B) Variant and Manual Model Details
            for (const vName in seriesObj) {
                if (vName === 'series_description') continue;
                const variant = seriesObj[vName];

                // B.1) Manual Model Details
                if (variant?.source === 'manual' && variant.details?.en) {
                    const details = variant.details;
                    details.processing_status ??= {};
                    const fields = [
                        { key: 'title', text: details.en.title },
                        { key: 'summary', text: details.en.summary },
                        { key: 'description', text: details.en.description },
                        { key: 'role', text: details.en.role },
                    ];

                    for (const lang of targetLanguages) {
                        details.processing_status[lang] ??= {};
                        for (const field of fields) {
                            if (!field.text) continue;
                            const sourceHash = simpleHash(field.text);
                            const currentStatus = details.processing_status[lang][field.key];
                            const storedHash = details.processing_status[lang][`${field.key}_source_hash`];
                            if (!COMPLETED_STATUSES.has(currentStatus) || storedHash !== sourceHash) {
                                tasks.push({ type: 'manual', pName, sName, vName, lang, englishText: field.text, sourceHash, textType: field.key, currentStatus, isStale: storedHash !== sourceHash });
                            }
                        }
                    }
                }
                // B.2) Online Variant Descriptions
                else if (variant?.description?.en && variant.source !== 'manual') {
                    const desc = variant.description;
                    desc.processing_status ??= {};
                    const sourceHash = simpleHash(desc.en);

                    for (const lang of targetLanguages) {
                        const currentStatus = desc.processing_status[lang];
                        const storedHash = desc.processing_status[`${lang}_source_hash`];
                        if (!COMPLETED_STATUSES.has(currentStatus) || storedHash !== sourceHash) {
                            tasks.push({ type: 'variant', pName, sName, vName, lang, englishText: desc.en, sourceHash, textType: 'description', currentStatus, isStale: storedHash !== sourceHash });
                        }
                    }
                }
            }
        }
    }

    // Prioritize tasks: stale/new items first, then retries, then EN verification.
    return tasks.sort((a, b) => {
        const getPriority = (task) => {
            if (task.isStale || !task.currentStatus || task.currentStatus === STATUS.NOT_PROCESSED) return 1;
            if (task.currentStatus === STATUS.TRANSLATION_RETRY) return 2;
            if (task.currentStatus === STATUS.GENERATED) return 3;
            return 99;
        };
        return getPriority(a) - getPriority(b);
    });
}