/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Manual / HuggingFace Normalizer (normalize/manual.js)
 * Description: Projects a merged producers-tree entry (source 'manual' or
 * 'huggingface') into a minimal CortexModel with a `local` block carrying
 * the curator/Hub-owned fields. These sources are KV/Hub-driven and are
 * rebuilt every run, so provider facts simply come from the tree itself.
 */

import { createCortexModel, finalizeCortexModel } from './schema.js';
import { identityFrom } from './identity.js';
import { normalizeModelId } from '../dedup.js';

/**
 * @param {{p: string, s: string, v: string, model: object}} entry - A tree entry from offlineEntries().
 * @returns {object|null} Finalized CortexModel, or null when malformed.
 */
export function cortexModelFromTreeEntry(entry) {
    const { p, s, v, model } = entry || {};
    if (!model?.id) return null;
    const source = model.source === 'huggingface' ? 'huggingface' : 'manual';
    const record = createCortexModel({
        id: model.id,
        source,
        canonicalKey: normalizeModelId(model.id, source) || model.id,
        category: 'chat',
    });

    record.identity = identityFrom({
        id: model.id,
        displayName: model.details?.en?.title || model.id,
        producer: p,
        series: s,
        variant: v,
        repoId: undefined,
    });
    record.identity.huggingFaceId = model.huggingface?.repoId || null;

    const vision = !!(model.modalities && model.modalities.image);
    record.modalities = {
        input: vision ? ['text', 'image'] : ['text'],
        output: ['text'],
        architectureModality: null,
    };
    record.capabilities = {
        chat: true,
        vision: vision || null,
        imageInput: vision || null,
        textInput: true,
        textOutput: true,
    };
    if (model.modalities?.audio) record.capabilities.audioInput = true;

    // Curator / Hub-owned execution facts for offline models.
    record.local = {
        type: model.type || null,
        url: model.url || null,
        imagePath: model.imagePath || null,
        size: model.size ?? null,
        ram: model.ram ?? null,
        chatFormat: model.chatFormat || null,
        licenseInfo: model.licenseInfo || null,
        repoId: model.huggingface?.repoId || null,
        downloads: model.huggingface?.downloads ?? null,
        likes: model.huggingface?.likes ?? null,
    };

    record.tier = model.tier || 'free';
    // raw stays null: the curator KV document (details/translations) is enrichment
    // served via the producers tree, not duplicated into the catalog.
    record.routes = [{ source, id: model.id, preferred: true, tier: record.tier }];
    return finalizeCortexModel(record);
}
