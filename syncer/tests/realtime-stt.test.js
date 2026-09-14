import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMaintainedRealtimeSttRecords } from '../processing/realtime-stt.js';
import { normalizeElevenLabsModel } from '../processing/normalize/elevenlabs.js';
import { validateCortexModel, valueOf } from '../processing/normalize/schema.js';

test('maintained adapter metadata publishes an AssemblyAI realtime STT role', () => {
    const [record] = buildMaintainedRealtimeSttRecords();
    assert.equal(record.task, 'realtime_stt');
    assert.equal(record.category, 'stt');
    assert.equal(record.source, 'assemblyai');
    assert.equal(valueOf(record.capabilities.realtime), true);
    assert.deepEqual(record.audio.sampleRates, [16000]);
    assert.equal(validateCortexModel(record).ok, true);
});

test('Scribe realtime metadata normalizes into the same role', () => {
    const record = normalizeElevenLabsModel({
        model_id: 'scribe_v2_realtime',
        name: 'Scribe v2 Realtime',
        can_do_speech_to_text: true,
        can_do_text_to_speech: false,
        languages: ['en', 'tr'],
    }, {
        identity: { producer: 'ElevenLabs', series: 'Scribe', variant: 'v2 Realtime' },
        canonicalKey: 'scribe_v2_realtime',
        catalogMatch: { key: 'scribe', asset: null, series: 'Scribe' },
    });
    assert.equal(record.task, 'realtime_stt');
    assert.equal(record.category, 'stt');
    assert.equal(valueOf(record.capabilities.interimResults), true);
    assert.deepEqual(record.audio.formats, ['pcm_16000']);
    assert.equal(validateCortexModel(record).ok, true);
});
