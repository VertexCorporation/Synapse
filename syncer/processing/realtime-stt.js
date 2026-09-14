/* Maintained realtime-STT metadata for providers without reliable discovery. */

import { createCortexModel, finalizeCortexModel, prov } from './normalize/schema.js';

export function buildMaintainedRealtimeSttRecords() {
    const record = createCortexModel({
        id: 'universal-3-5-pro',
        source: 'assemblyai',
        canonicalKey: 'assemblyai:universal-3-5-pro',
        category: 'stt',
        task: 'realtime_stt',
    });
    record.identity = {
        displayName: 'Universal-3-5 Pro',
        producer: 'AssemblyAI',
        producerSlug: 'assemblyai',
        family: prov('Universal', 'provider_adapter'),
        series: 'Universal',
        variant: '3-5 Pro',
        version: '3-5',
    };
    record.lifecycle.status = 'maintained';
    record.capabilities = {
        streaming: prov(true, 'provider_adapter'),
        realtime: prov(true, 'provider_adapter'),
        speechToText: prov(true, 'provider_adapter'),
        audioInput: prov(true, 'provider_adapter'),
        textOutput: prov(true, 'provider_adapter'),
        interimResults: prov(true, 'provider_adapter'),
        finalResults: prov(true, 'provider_adapter'),
        multilingual: null,
        automaticLanguageDetection: null,
        codeSwitching: null,
        vad: prov(true, 'provider_adapter'),
        endpointing: prov(true, 'provider_adapter'),
    };
    record.modalities = { input: ['audio'], output: ['text'], architectureModality: null };
    record.audio = { formats: ['pcm_s16le'], sampleRates: [16000], channels: 1, pcm: true };
    record.routing.languages = null;
    record.raw = { source: 'maintained_adapter', model: 'universal-3-5-pro' };
    record.tier = 'standard';
    return [finalizeCortexModel(record)];
}

