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

    // This block contains numerous provider-specific rules.
    // Each 'if/else if' block handles the naming conventions for a specific provider.
    // ... (The entire, long if/else if block from the original code goes here) ...
    // --- Specific provider rules ---
    if (PRODUCER_MAP[providerId]) {
        // Add/Refine rules for providers based on common naming patterns in openrouterapi.txt
        if (providerId === "openai") {
          series = /codex/i.test(cleanedName) ? "Codex" : "ChatGPT";
          variant = cleanedName.replace(/^(OpenAI\s*[:-\s]*)?/i, "").trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "meta-llama") {
          series = "Llama";
          variant = cleanedName
            .replace(/^(Meta-Llama|Meta Llama|Llama)\s*[\d.]*\s*[:-\s]*/i, "")
            .trim();
          variant = stripLeftOfColonForVariant(variant);
          if (variant.toLowerCase().startsWith(series.toLowerCase() + " ")) {
            variant = variant.substring(series.length).trim();
          }
        } else if (providerId === "microsoft") {
          if (/phi-\d+(\.\d+)?/i.test(cleanedName)) series = "Phi";
          else if (/phi/i.test(cleanedName)) series = "Phi";
          else if (/wizardlm/i.test(cleanedName)) series = "WizardLM";
          variant = cleanedName
            .replace(
              new RegExp(
                `^${providerDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:-\\s]*`,
                "i",
              ),
              "",
            )
            .trim();
          variant = stripLeftOfColonForVariant(variant);
          variant = variant
            .replace(
              new RegExp(
                `^${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
                "i",
              ),
              "",
            )
            .trim();
        } else if (providerId === "amazon") {
          series = "Nova";
          variant = cleanedName
            .replace(/^(Amazon\s*[:-\s]*|Nova\s*[:-\s]*)/i, "")
            .trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "perplexity") {
          series =
            /r1/i.test(cleanedName) && !/sonar/i.test(cleanedName)
              ? "R1 Series"
              : "Sonar";
          variant = cleanedName
            .replace(
              new RegExp(
                `^${providerDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:-\\s]*|${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:-\\s]*`,
                "i",
              ),
              "",
            )
            .trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "deepseek") {
          series = "DeepSeek";
          variant = cleanedName.replace(/^(DeepSeek\s*[:-\s]*)?/i, "").trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "qwen") {
          series = "Qwen";
          variant = cleanedName.replace(/^(Qwen\s*[:-\s]*)?/i, "").trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "nousresearch") {
          series = "Hermes";
          variant = cleanedName
            .replace(
              /^(NousResearch\s*[:-\s]*|Hermes\s*[:-\s]*|DeepHermes\s*[:-\s]*)/i,
              "",
            )
            .trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "mistralai") {
          if (/codestral/i.test(cleanedName)) series = "Codestral";
          else if (/mixtral/i.test(cleanedName)) series = "Mixtral";
          else if (/ministral/i.test(cleanedName)) series = "Ministral";
          else series = "Mistral";
          variant = cleanedName
            .replace(
              /^(Mistral AI\s*[:-\s]*|Mistral\s*[:-\s]*|Codestral\s*[:-\s]*|Mixtral\s*[:-\s]*|Ministral\s*[:-\s]*)/i,
              "",
            )
            .trim();
          variant = stripLeftOfColonForVariant(variant);
          variant = variant.replace(/\s*(?:v\d\.\d+|\d{4})$/i, "").trim();
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
          variant = cleanedName
            .replace(/^(Google\s*[:-\s]*|Gemini\s*[:-\s]*|Gemma\s*[:-\s]*)/i, "")
            .trim();
          variant = stripLeftOfColonForVariant(variant);
        } else if (providerId === "x-ai") {
          series = "Grok";
          variant = cleanedName
            .replace(/^(xAI\s*[:-\s]*|Grok\s*[:-\s]*)/i, "")
            .trim();
          variant = stripLeftOfColonForVariant(variant);
        }
        else if (providerId === "arcee-ai") {
          series = "Arcee AI";
          variant = cleanedName
            .replace(/^Arcee AI\s*[:-\s]*/i, "")
            .trim();
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

    // Final cleanup and validation
    variant = variant || cleanedName || rawName;
    if (variant.toLowerCase().startsWith(series.toLowerCase() + " ") && series !== providerDisplayName) {
        variant = variant.substring(series.length).trim();
    }
    if (!variant || variant.toLowerCase() === providerDisplayName?.toLowerCase() || variant.toLowerCase() === series?.toLowerCase()) {
        variant = cleanedName || rawName;
    }

    return { series, variant };
}