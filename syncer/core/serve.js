/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Serve Logic
 * Description: Handles the fetch requests for the public /models.json endpoint.
 * Implements a highly efficient Cache-First strategy to minimize KV reads.
 */

import { DEFAULTS } from '../config.js';

/**
 * Serves the models.json file, prioritizing Edge Cache over KV reads.
 * @param {object} env - The environment object containing bindings.
 * @param {Request} request - The incoming request object.
 * @param {object} context - The worker execution context for `waitUntil`.
 * @returns {Promise<Response>} A Response object containing the models JSON or an error.
 */
export async function serveModelsJson(env, request, context) {
    const opId = `serve-${Date.now()}`;
    const MODELS_KV = env.MODELS_JSON;

    if (!MODELS_KV?.get) {
        console.error(`❌ [${opId}] MODELS_JSON KV is not bound.`);
        return new Response(JSON.stringify({ error: "Service configuration error." }), { status: 500 });
    }

    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + "/models.json");

    try {
        // FAST PATH: Serve from cache if available
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
            console.log(`⚡ [${opId}] Cache HIT. Serving from Edge Cache.`);
            return cachedResponse;
        }

        console.log(`🐢 [${opId}] Cache MISS. Fetching from KV.`);

        // SLOW PATH: Fetch from KV, build response, and cache it
        const [listJson, kvVersion, blacklist] = await Promise.all([
            MODELS_KV.get("list"),
            MODELS_KV.get("version"),
            MODELS_KV.get("model_blacklist", "json")
        ]);

        if (!listJson) {
            console.warn(`⚠️ [${opId}] 'list' not found in KV. Serving default empty data.`);
            const defaultData = { version: new Date().toISOString(), producers: {} };
            return new Response(JSON.stringify(defaultData), { status: 404 });
        }

        let data = JSON.parse(listJson);
        const blacklistedIds = new Set(blacklist || []);

        // Filter blacklisted models if any
        if (blacklistedIds.size > 0) {
            for (const pName in data.producers) {
                for (const sName in data.producers[pName]) {
                    for (const vName in data.producers[pName][sName]) {
                         if (data.producers[pName][sName][vName]?.id && blacklistedIds.has(data.producers[pName][sName][vName].id)) {
                             delete data.producers[pName][sName][vName];
                         }
                    }
                     if (Object.keys(data.producers[pName][sName]).length === 0) delete data.producers[pName][sName];
                }
                 if (Object.keys(data.producers[pName]).length === 0) delete data.producers[pName];
            }
        }
        
        const responseHeaders = {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${DEFAULTS.CACHE_TTL_S}, stale-while-revalidate=${DEFAULTS.STALE_TTL_S}`,
            "ETag": `"${kvVersion || Date.now()}"`,
            "Access-Control-Allow-Origin": "*",
        };
        
        const response = new Response(JSON.stringify(data), { status: 200, headers: responseHeaders });

        context.waitUntil(
            cache.put(cacheKey, response.clone())
                .then(() => console.log(`✅ [${opId}] Response stored in Edge Cache.`))
                .catch(e => console.error(`❌ [${opId}] Failed to cache response: ${e.message}`))
        );

        return response;

    } catch (error) {
        console.error(`❌ [${opId}] CRITICAL ERROR in serveModelsJson: ${error.message}`, error.stack);
        return new Response(JSON.stringify({ error: "Internal server error." }), { status: 500 });
    }
}