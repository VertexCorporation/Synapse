/*
 * Cortex - Syncer Worker - Catalog Standardization
 *
 * Module: Provider Docs (config/provider-docs.js)
 * Description: Model-card facts that providers do NOT expose through their
 * list endpoints. Kept separate from code so updates are data edits with a
 * docVersion stamp. Everything here is provenance source 'docs'.
 */

export const PROVIDER_DOCS_VERSION = '2026-09-09';
export const PROVIDER_DOCS_URL = 'https://console.groq.com/docs/models';

/**
 * Groq reasoning model-card facts (design doc §8.2).
 * Matched by substring against the model id. `mandatory: true` means the model
 * always produces reasoning (cannot be disabled).
 */
const GROQ_REASONING_RULES = [
    { pattern: 'gpt-oss', supported: true, mandatory: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { pattern: 'deepseek-r1', supported: true, mandatory: true },
    { pattern: 'qwq', supported: true, mandatory: true },
    { pattern: 'qwen3', supported: true, mandatory: false },
    { pattern: 'kimi-k2-thinking', supported: true, mandatory: true },
];

/** @returns {{supported: boolean, mandatory: boolean, efforts?: string[], defaultEffort?: string}|null} */
export function groqReasoningDocs(modelId) {
    const lower = String(modelId || '').toLowerCase();
    for (const rule of GROQ_REASONING_RULES) {
        if (lower.includes(rule.pattern)) {
            return {
                supported: rule.supported,
                mandatory: rule.mandatory,
                efforts: rule.efforts ?? null,
                defaultEffort: rule.defaultEffort ?? null,
            };
        }
    }
    return null;
}

/**
 * Groq `compound` / `compound-mini` run built-in web search + code execution
 * before answering (documented product behavior, not exposed by /models).
 */
export function isGroqCompound(modelId) {
    return /^groq\/compound(-mini)?$/i.test(String(modelId || ''));
}
