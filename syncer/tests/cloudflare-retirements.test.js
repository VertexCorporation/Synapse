import test from 'node:test';
import assert from 'node:assert/strict';

import { RETIRED_CLOUDFLARE_MODEL_IDS } from '../config.js';
import { matchCatalogModel } from '../processing/catalog-policy.js';
import { mergeCatalogRecords } from '../processing/merge.js';

test('November 2026 Cloudflare retirement IDs are explicit and non-duplicated', () => {
    assert.equal(RETIRED_CLOUDFLARE_MODEL_IDS.size, 24);
    for (const id of RETIRED_CLOUDFLARE_MODEL_IDS) {
        assert.ok(id.startsWith('@cf/'), `invalid Cloudflare ID: ${id}`);
        assert.equal(matchCatalogModel('cloudflare', id), null, `retired ID still eligible: ${id}`);
    }
});

test('supported Cloudflare models remain eligible after retirement filtering', () => {
    for (const id of [
        '@cf/meta/llama-3.2-11b-vision-instruct',
        '@cf/google/gemma-4-26b-a4b-it',
        '@cf/qwen/qwen3.8-27b',
    ]) {
        assert.ok(matchCatalogModel('cloudflare', id), `active ID was accidentally blocked: ${id}`);
    }
});

test('retired Cloudflare records cannot survive a failed provider sync or reappear as fresh', () => {
    const retired = '@cf/moonshotai/kimi-k2.6';
    const active = '@cf/meta/llama-3.2-11b-vision-instruct';
    const oldCatalog = [
        { id: retired, source: 'cloudflare', absentStreak: 0 },
        { id: active, source: 'cloudflare', absentStreak: 0 },
    ];
    const current = mergeCatalogRecords([], oldCatalog, { cloudflare: false }, 'retirement-test');
    assert.deepEqual(current.map(x => x.id), [active], 'active last-known-good should survive the outage');

    const returned = mergeCatalogRecords(
        [{ id: retired, source: 'cloudflare', absentStreak: 0 }],
        oldCatalog,
        { cloudflare: true },
        'retirement-test',
    );
    assert.equal(returned.some(x => x.id === retired), false, 'retired ID must never be rehydrated');
});
