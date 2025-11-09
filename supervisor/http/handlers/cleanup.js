/*
 * Cortex Supervisor Worker - Cleanup Endpoint Handler
 * Resets corrupted (excessively long) descriptions in the KV store.
 */

/**
 * Scans and cleans corrupted description fields from the models list.
 * @param {object} modelsKv The MODELS_JSON KV namespace.
 * @param {object} settings The application settings object.
 * @param {object} logger A logger instance.
 * @param {string} opId The operation ID.
 * @returns {Promise<{status: string, message: string, cleaned_items?: Array<string>}>} A result object.
 */
export async function performCleanup(modelsKv, settings, logger, opId) {
    const listStr = await modelsKv.get('list');
    if (!listStr) {
        return { status: "ok", message: "KV 'list' is empty, nothing to clean." };
    }

    const data = JSON.parse(listStr);
    const cleanedItems = [];
    const { seriesEn, seriesTranslation, variantTranslation } = settings.cleanupThresholds;

    logger.info(`Cleanup rules: Series EN > ${seriesEn}, Series TR/FR > ${seriesTranslation}, Variant TR/FR > ${variantTranslation}.`);

    for (const pName in data.producers) {
        for (const sName in data.producers[pName]) {
            const series = data.producers[pName][sName];
            
            // Rule 1: Clean AI-generated series descriptions
            if (series.series_description) {
                const desc = series.series_description;
                const path = `${pName}/${sName}/series_description`;
                if (typeof desc.en === 'string' && desc.en.length > seriesEn) {
                    cleanedItems.push(`${path}.en (Len: ${desc.en.length})`);
                    delete desc.en;
                    if (desc.processing_status) delete desc.processing_status.en;
                }
                for (const lang of settings.targetLanguages) {
                    if (typeof desc[lang] === 'string' && desc[lang].length > seriesTranslation) {
                        cleanedItems.push(`${path}.${lang} (Len: ${desc[lang].length})`);
                        delete desc[lang];
                        if (desc.processing_status) {
                            delete desc.processing_status[lang];
                            delete desc.processing_status[`${lang}_source_hash`];
                        }
                    }
                }
            }

            // Rule 2: Clean variant description translations (online & manual)
            for (const vName in series) {
                if (vName === 'series_description') continue;
                const variant = series[vName];
                const processObject = variant.description || (variant.source === 'manual' ? variant.details : null);
                if (!processObject) continue;

                const pathPrefix = `${pName}/${sName}/${vName}`;
                const fieldsToClean = variant.source === 'manual' ? ['title', 'summary', 'description', 'role'] : ['description'];
                
                for (const lang of settings.targetLanguages) {
                    const langObj = variant.source === 'manual' ? processObject[lang] : { 'description': processObject[lang] };
                    if (!langObj) continue;
                    
                    for (const field of fieldsToClean) {
                        if (typeof langObj[field] === 'string' && langObj[field].length > variantTranslation) {
                             const path = variant.source === 'manual' ? `${pathPrefix}/details.${lang}.${field}` : `${pathPrefix}/description.${lang}`;
                             cleanedItems.push(`${path} (Len: ${langObj[field].length})`);
                             delete langObj[field];
                             
                             if (processObject.processing_status?.[lang]) {
                                 delete processObject.processing_status[lang][field];
                                 delete processObject.processing_status[lang][`${field}_source_hash`];
                             }
                        }
                    }
                }
            }
        }
    }

    if (cleanedItems.length > 0) {
        logger.info(`[CLEANUP] Found and reset ${cleanedItems.length} corrupted fields. Saving to KV.`);
        const newVersion = `cleanup-${new Date().toISOString()}`;
        data.last_supervisor_run = opId;
        data.last_supervisor_update_ts = newVersion;

        await modelsKv.put('list', JSON.stringify(data));
        await modelsKv.put('version', newVersion);

        return {
            status: "success",
            message: `Successfully cleaned ${cleanedItems.length} fields.`,
            cleaned_items: cleanedItems
        };
    }

    logger.info('[CLEANUP] No corrupted descriptions found.');
    return { status: "ok", message: "No items to clean." };
}