/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Fal Normalizer (normalize/fal.js)
 * Description: Maps a CONSOLIDATED fal entry (base model with its task
 * endpoints merged, see fal-models.js) to a canonical CortexModel. Endpoints
 * become routing.endpointIds / defaultEndpoint; heavy thumbnails are dropped.
 */

import { createCortexModel, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';
import { categoryFromFalCategory } from './tasks.js';

/**
 * Derives a category from the consolidated entry's endpoints: the default
 * endpoint's category wins; the input/output modality union is the fallback.
 */
function falCategory(model) {
    const fal = model.fal || {};
    const endpoints = Array.isArray(fal.endpoints) ? fal.endpoints : [];
    const byId = new Map(endpoints.map(e => [e.id, e]));
    const primary = byId.get(fal.defaultEndpoint) || endpoints[0] || {};
    const fromCategory = categoryFromFalCategory(primary.category);
    if (fromCategory) return fromCategory;
    const outputs = model.outputs || {};
    const inputs = model.modalities || {};
    if (outputs.video) return inputs.video ? 'video-edit' : 'video-gen';
    if (outputs.image) return inputs.image ? 'image-edit' : 'image-gen';
    if (outputs.audio) return 'audio-gen';
    return 'other';
}

/**
 * @param {{p: string, s: string, v: string, model: object}} entry - A consolidated fal tree entry
 *   (model.fal = { version, baseId, defaultEndpoint, endpoints: [{id, category, group, ...meta}] }).
 */
export function normalizeFalModel(entry) {
    const { p, s, v, model } = entry;
    const fal = model.fal || {};
    const endpoints = Array.isArray(fal.endpoints) ? fal.endpoints : [];
    const byId = new Map(endpoints.map(e => [e.id, e]));
    const primary = byId.get(fal.defaultEndpoint) || endpoints[0] || {};
    const category = falCategory(model);

    const record = createCortexModel({
        id: model.id,
        source: 'fal',
        canonicalKey: fal.baseId || model.id,
        category,
    });

    record.identity = identityFrom({
        id: model.id,
        displayName: fal.baseId?.split('/').pop() || model.id,
        producer: p,
        series: s,
        variant: v,
    });

    const inputs = model.modalities || {};
    const outputs = model.outputs || {};
    record.modalities = {
        input: ['text', inputs.image && 'image', inputs.video && 'video', inputs.audio && 'audio'].filter(Boolean),
        output: [outputs.image && 'image', outputs.video && 'video', outputs.audio && 'audio'].filter(Boolean),
        architectureModality: null,
    };

    record.capabilities = {
        imageGeneration: outputs.image || null,
        videoGeneration: outputs.video || null,
        imageInput: inputs.image || null,
        videoInput: inputs.video || null,
        audioInput: inputs.audio || null,
        imageOutput: outputs.image || null,
        videoOutput: outputs.video || null,
        audioOutput: outputs.audio || null,
    };

    record.routing.endpointIds = endpoints.map(e => e.id);
    record.routing.defaultEndpoint = fal.defaultEndpoint || null;

    if (primary.status) record.lifecycle.status = primary.status === 'active' ? 'ga' : primary.status;
    if (primary.license) record.license = primary.license;
    if (primary.createdAt) record.lifecycle.createdAt = primary.createdAt;
    if (primary.updatedAt) record.lifecycle.updatedAt = primary.updatedAt;

    // raw: endpoint table minus thumbnail URLs (design §9 size guard).
    record.raw = {
        baseId: fal.baseId || null,
        group: primary.group || null,
        endpoints: endpoints.map(({ id, category: endpointCategory, status, license, group }) => ({
            id, category: endpointCategory || null, status: status || null,
            license: license || null, group: group || null,
        })),
    };
    record.tier = model.tier || 'standard';
    return finalizeCortexModel(record);
}
