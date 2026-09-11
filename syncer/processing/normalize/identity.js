/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Catalog Identity Helpers (normalize/identity.js)
 * Description: Builds the canonical `identity` block from the producer /
 * series / variant placement computed by each processor's parser. The catalog
 * explicitly carries company and series identity — clients never infer it.
 */

import { prov } from './schema.js';

/** URL-safe slug for a producer display name (e.g. "Black Forest Labs" -> "black-forest-labs"). */
export function slugify(text) {
    const slug = String(text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || null;
}

/**
 * Parses a parameter size (e.g. "70B", "1.5M") from an id / display name.
 * @returns {object|null} Provenance triplet { value: "70B", source: 'parsed_id', confidence: 0.9 }.
 */
export function parseParameterSize(...texts) {
    for (const text of texts) {
        if (!text) continue;
        const match = /(\d+(?:\.\d+)?)\s*(b|m|t)\b/i.exec(String(text));
        if (match) {
            const unit = { b: 'B', m: 'M', t: 'T' }[match[2].toLowerCase()];
            return prov(`${match[1]}${unit}`, 'parsed_id', 0.9);
        }
    }
    return null;
}

/**
 * Builds the canonical identity block.
 * @param {{id: string, displayName?: string, producer?: string, series?: string,
 *          variant?: string, huggingFaceId?: string, baseModel?: string, version?: string}} input
 *   `producer`/`series`/`variant` come from the processor's parser (authoritative placement).
 */
export function identityFrom({ displayName, producer, series, variant, huggingFaceId, baseModel, version, ...rest }) {
    return {
        displayName: displayName ?? null,
        producer: producer ?? null,
        producerSlug: slugify(producer),
        // The family is the series name the processor placed this model under.
        // It is derived from the id/name at ingest, never guessed by the client.
        family: series ? prov(series, 'parsed_id', 0.9) : null,
        series: series ?? null,
        variant: variant ?? null,
        parameterSize: parseParameterSize(rest.id, displayName),
        version: version ?? null,
        huggingFaceId: huggingFaceId || null,
        baseModel: baseModel ?? null,
        aliases: [],
    };
}
