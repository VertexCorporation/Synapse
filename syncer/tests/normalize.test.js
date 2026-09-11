import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateCortexModel, valueOf } from '../processing/normalize/schema.js';
import { normalizeModelId } from '../processing/dedup.js';
import { extractSeriesVariant } from '../processing/parser.js';
import { parseGroqModelIdentity } from '../processing/groq.js';
import { parseCloudflareModelIdentity } from '../processing/cloudflare.js';
import { normalizeOpenRouterModel } from '../processing/normalize/openrouter.js';
import { normalizeGroqModel } from '../processing/normalize/groq.js';
import { normalizeCloudflareModel } from '../processing/normalize/cloudflare.js';
import { normalizeElevenLabsModel } from '../processing/normalize/elevenlabs.js';
import { normalizeDeepgramModel } from '../processing/normalize/deepgram.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = name => JSON.parse(fs.readFileSync(join(fixtures, `${name}.json`), 'utf8'));

function assertAllValid(records, label) {
    for (const record of records) {
        const { ok, errors } = validateCortexModel(record);
        assert.ok(ok, `${label} "${record?.id}": ${errors.join('; ')}`);
        assert.ok(record.metadataQuality.quality > 0, `${label} "${record.id}": quality must be > 0`);
    }
}

test('openrouter fixture normalizes to valid CortexModels', () => {
    const payload = load('openrouter');
    const records = [];
    for (const model of payload.data) {
        const providerId = model.id.split('/')[0];
        const { series, variant } = extractSeriesVariant({ rawName: model.name, providerId, providerDisplayName: providerId });
        records.push(normalizeOpenRouterModel(model, {
            identity: { producer: providerId, series, variant },
            canonicalKey: normalizeModelId(model.id, 'openrouter'),
            tier: model.id.endsWith(':free') ? 'fallback' : 'standard',
            catalogMatch: null,
        }));
    }
    assert.ok(records.length >= 8, 'fixture should keep several models');
    assertAllValid(records, 'openrouter');

    const claude = records.find(r => r.id === 'anthropic/claude-sonnet-4.5');
    assert.equal(claude.limits.contextTokens, 1_000_000);
    assert.equal(claude.limits.maxOutputTokens, 64000);
    assert.equal(claude.pricing.inputPerToken, 0.000003);
    assert.equal(claude.pricing.outputPerToken, 0.000015);
    assert.equal(valueOf(claude.capabilities.reasoning), true);
    assert.equal(valueOf(claude.capabilities.tools), true);
    assert.equal(claude.capabilities.streaming.source, 'docs');
    assert.equal(claude.lifecycle.knowledgeCutoff, '2025-01-31');
    assert.deepEqual(claude.modalities.input, ['text', 'image', 'file']);

    const free = records.find(r => r.id.endsWith(':free'));
    assert.ok(free, 'fixture should contain a :free model');
    assert.equal(free.tier, 'fallback');
    assert.equal(free.pricing.free, true);
    assert.ok(!free.canonicalKey.includes(':free'));
});

test('groq fixture normalizes with null-safe limits (no invented 8192 context)', () => {
    const payload = load('groq');
    const records = payload.data.map(model => normalizeGroqModel(model, {
        identity: parseGroqModelIdentity(model.id, model.owned_by),
        canonicalKey: normalizeModelId(model.id, 'groq'),
        catalogMatch: null,
    }));
    assertAllValid(records, 'groq');

    const guard = records.find(r => /prompt-guard|safeguard/.test(r.id));
    assert.equal(guard.category, 'moderation');
    assert.equal(guard.limits.contextTokens, guard.raw.context_window);
    assert.notEqual(guard.limits.contextTokens, 8192);

    const qwen = records.find(r => /qwen3/.test(r.id));
    assert.ok(qwen, 'fixture should contain a qwen3 chat model');
    assert.equal(qwen.category, 'chat');
    assert.equal(qwen.limits.contextTokens, qwen.raw.context_window);
    assert.equal(valueOf(qwen.capabilities.reasoning), true); // declared via supported_features
    assert.equal(valueOf(qwen.capabilities.tools), true);
    const whisper = records.find(r => /whisper/.test(r.id));
    if (whisper) {
        assert.equal(whisper.category, 'stt');
        assert.equal(whisper.capabilities.speechToText, true);
    }
});

test('cloudflare fixture: properties array is read, context is real, task != reasoning', () => {
    const payload = load('cloudflare');
    const records = payload.result.map(item => {
        const modelId = item.name || item.id;
        return normalizeCloudflareModel(item, {
            identity: parseCloudflareModelIdentity(modelId),
            canonicalKey: normalizeModelId(modelId, 'cloudflare'),
            catalogMatch: null,
            modalities: { image: false, video: false, audio: false, file: false },
            outputs: { image: false, video: false, audio: false },
        });
    });
    assertAllValid(records, 'cloudflare');

    // THE FIX: legacy code read properties.max_context off an ARRAY -> always 0.
    const gptOss = records.find(r => r.id === '@cf/openai/gpt-oss-120b');
    assert.ok(gptOss, 'fixture should contain gpt-oss-120b');
    assert.equal(gptOss.limits.contextTokens, 128000);
    assert.equal(gptOss.pricing.inputPerToken, 0.35 / 1e6);
    assert.equal(gptOss.pricing.outputPerToken, 0.75 / 1e6);
    assert.equal(valueOf(gptOss.capabilities.reasoning), true);
    assert.equal(gptOss.capabilities.reasoning.source, 'cloudflare');
    assert.equal(valueOf(gptOss.capabilities.tools), true);
    assert.equal(gptOss.category, 'chat');

    const whisper = records.find(r => /whisper/.test(r.id));
    if (whisper) {
        assert.equal(whisper.category, 'stt');
        assert.ok(whisper.limits?.contextTokens == null); // no context_window property -> unknown
    }
});

test('elevenlabs fixture: character limits are not token context', () => {
    const payload = load('elevenlabs');
    const records = payload.map(model => normalizeElevenLabsModel(model, {
        identity: { producer: 'ElevenLabs', series: 'Eleven Voice', variant: model.name },
        canonicalKey: normalizeModelId(model.model_id, 'elevenlabs'),
        catalogMatch: null,
    }));
    assertAllValid(records, 'elevenlabs');

    for (const record of records) {
        assert.ok(record.limits?.contextTokens == null, 'TTS models have no token window');
        assert.equal(record.limits.maxInputCharacters, record.raw.max_characters_request_subscribed_user);
        const expected = record.raw.can_do_text_to_speech !== false ? 'tts'
            : (record.raw.can_do_voice_conversion ? 'sts' : 'stt');
        assert.equal(record.category, expected);
        if (record.category === 'tts') assert.equal(record.capabilities.textToSpeech, true);
        if (record.category === 'sts') {
            assert.deepEqual(record.modalities, { input: ['audio'], output: ['audio'] });
            assert.equal(record.capabilities.voiceCloning, true);
        }
        assert.ok(Array.isArray(record.routing.languages) && record.routing.languages.length > 0);
        assert.ok(!record.raw.languages, 'raw languages are trimmed (already normalized)');
    }
});

test('deepgram fixture: streaming flags and languages come from the API', () => {
    const payload = load('deepgram');
    const records = payload.stt.map(model => normalizeDeepgramModel(model, {
        kind: 'stt',
        identity: { producer: 'Deepgram', series: 'Nova', variant: model.name },
        canonicalKey: normalizeModelId(model.canonical_name || model.name, 'deepgram'),
        catalogMatch: null,
    }));
    assertAllValid(records, 'deepgram-stt');
    const nova = records.find(r => /nova/.test(r.id));
    if (nova) {
        assert.equal(nova.category, 'stt');
        assert.equal(nova.capabilities.streaming, nova.raw.streaming);
        assert.equal(nova.identity.version, nova.raw.version);
        assert.deepEqual(nova.modalities, { input: ['audio'], output: ['text'] });
    }

    const tts = payload.tts.map(model => normalizeDeepgramModel(model, {
        kind: 'tts',
        identity: { producer: 'Deepgram', series: 'Aura', variant: model.name },
        canonicalKey: normalizeModelId(model.canonical_name || model.name, 'deepgram'),
        catalogMatch: null,
    }));
    assertAllValid(tts, 'deepgram-tts');
});

