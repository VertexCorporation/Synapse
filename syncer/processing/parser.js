/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Model Name Parser
 * Description: Extracts a structured "Series" and "Variant" from a raw model name string.
 * This logic is complex and provider-specific, so it's isolated in its own module.
 */

import { PRODUCER_MAP } from '../config.js';
import { cleanNameForVariant, stripLeftOfColonForVariant } from '../utils/helpers.js';

/**
 * Extracts a structured series and variant name from a raw model name based on provider-specific rules.
 * @param {{rawName: string, providerId: string, providerDisplayName: string}} modelInput - The input model info.
 * @param {string} operationId - The operation ID for logging.
 * @returns {{series: string, variant: string}} The extracted series and variant.
 */
export function extractSeriesVariant(modelInput, operationId) {
    const { rawName, providerId, providerDisplayName } = modelInput;
    let cleanedName = cleanNameForVariant(rawName);
    let series = "", variant = "";

    if (PRODUCER_MAP[providerId]) {
        // --- Specific provider rules ---
        if (providerId === "openai") {
            if (/codex/i.test(cleanedName)) series = "Codex";
            else series = "ChatGPT";
            
            variant = cleanedName.replace(/^(OpenAI\s*[:-\s]*)?/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "meta-llama") {
            series = "Llama";
            variant = cleanedName
                .replace(/^(Meta-Llama|Meta Llama|Llama)\s*[\d.]*\s*[:-\s]*/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "microsoft") {
            if (/phi/i.test(cleanedName)) series = "Phi";
            else if (/wizardlm/i.test(cleanedName)) series = "WizardLM";
            else if (/mai/i.test(cleanedName)) series = "MAI";

            variant = cleanedName.replace(/^(Microsoft\s*[:-\s]*)?/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);
            if (series) { // Only strip series name if it was found
                 variant = variant.replace(new RegExp(`^${series}\\s*`, "i"), "").trim();
            }

        } else if (providerId === "amazon") {
            series = "Nova";
            variant = cleanedName
                .replace(/^(Amazon\s*[:-\s]*|Nova\s*[:-\s]*)/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "perplexity") {
            if (/sonar/i.test(cleanedName)) series = "Sonar";
            else if (/r1/i.test(cleanedName)) series = "R1 Series";
            else series = "Perplexity";

            variant = cleanedName.replace(/^(Perplexity\s*[:-\s]*|Sonar\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);
        
        } else if (providerId === "deepseek") {
             series = "DeepSeek";
             variant = cleanedName.replace(/^(DeepSeek\s*[:-\s]*)/i, "").trim();
             variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "qwen") {
            series = "Qwen";
            variant = cleanedName.replace(/^(Qwen\s*[:-\s]*|QwQ\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "nousresearch") {
            series = "Hermes";
            variant = cleanedName
                .replace(/^(NousResearch\s*[:-\s]*|Nous\s*[:-\s]*|Hermes\s*[:-\s]*|DeepHermes\s*[:-\s]*)/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "mistralai") {
            if (/codestral/i.test(cleanedName)) series = "Codestral";
            else if (/devstral/i.test(cleanedName)) series = "Devstral";
            else if (/mixtral/i.test(cleanedName)) series = "Mixtral";
            else if (/ministral/i.test(cleanedName)) series = "Ministral";
            else if (/magistral/i.test(cleanedName)) series = "Magistral";
            else if (/pixtral/i.test(cleanedName)) series = "Pixtral";
            else series = "Mistral";

            variant = cleanedName
                .replace(/^(Mistral AI\s*[:-\s]*|Mistral\s*[:-\s]*|Codestral\s*[:-\s]*|Devstral\s*[:-\s]*|Mixtral\s*[:-\s]*|Ministral\s*[:-\s]*|Magistral\s*[:-\s]*|Pixtral\s*[:-\s]*)/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);
            
        } else if (providerId === "anthropic") {
            series = "Claude";
            variant = cleanedName
                .replace(/^(Anthropic\s*[:-\s]*|Claude\s*[:-\s]*)/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "cohere") {
            series = "Command";
            variant = cleanedName
                .replace(/^(Cohere\s*[:-\s]*|Command\s*[:-\s]*)/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "google") {
            if (/gemini/i.test(cleanedName)) series = "Gemini";
            else if (/gemma/i.test(cleanedName)) series = "Gemma";
            else series = "Google";

            variant = cleanedName.replace(/^(Google\s*[:-\s]*|Gemini\s*[:-\s]*|Gemma\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "x-ai") {
            series = "Grok";
            variant = cleanedName
                .replace(/^(xAI\s*[:-\s]*|Grok\s*[:-\s]*)/i, "")
                .trim();
            variant = stripLeftOfColonForVariant(variant);
        
        } else if (providerId === "arcee-ai") {
            series = "Arcee AI";
            variant = cleanedName.replace(/^Arcee AI\s*[:-\s]*/i, "").trim();

        } else if (providerId === "moonshotai") {
            series = "Kimi";
            variant = cleanedName.replace(/^(MoonshotAI\s*[:-\s]*|Kimi\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "nvidia") {
            series = "Nemotron";
            variant = cleanedName.replace(/^(NVIDIA\s*[:-\s]*|Nemotron\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "inclusionai") {
            if (/ling/i.test(cleanedName)) series = "Ling";
            else if (/ring/i.test(cleanedName)) series = "Ring";
            else series = "inclusionAI";
            
            variant = cleanedName.replace(/^(inclusionAI\s*[:-\s]*|Ling\s*[:-\s]*|Ring\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "z-ai") {
            series = "GLM";
            variant = cleanedName.replace(/^(Z\.AI\s*[:-\s]*|GLM\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else if (providerId === "liquid") {
            series = "LFM";
            variant = cleanedName.replace(/^(LiquidAI\/\s*|LFM)\s*[\d.]*\s*/i, "").trim();

        } else if (providerId === "ibm-granite") {
            series = "Granite";
            variant = cleanedName.replace(/^(IBM\s*[:-\s]*|Granite\s*[:-\s]*)/i, "").trim();
            variant = stripLeftOfColonForVariant(variant);

        } else {
            console.warn(`[${operationId}] Unhandled provider rule for: "${providerId}". Using defaults.`);
            series = providerDisplayName;
            variant = cleanedName;
        }
    } else {
        console.error(`❌ [${operationId}] Internal Error: Provider ID "${providerId}" not in ALLOWED_PROVIDER_IDS.`);
        series = "Unknown Provider";
        variant = rawName;
    }

    // Fallback if no series was determined
    if (!series) {
        console.warn(`[${operationId}] No series rule matched for provider "${providerId}" and name "${rawName}". Using defaults.`);
        series = providerDisplayName;
        variant = cleanedName;
    }

    // Final cleanup and validation
    variant = variant || cleanedName || rawName;
    if (variant.toLowerCase().startsWith(series.toLowerCase() + " ") && series !== providerDisplayName) {
        variant = variant.substring(series.length).trim();
    }
    if (!variant || variant.toLowerCase() === providerDisplayName?.toLowerCase() || variant.toLowerCase() === series?.toLowerCase()) {
        variant = cleanedName || rawName;
    }

    return { series, variant: variant.trim() };
}