/*
 * Cortex Curator Worker - v2.1 (Transactional & CORS-Compliant API)
 * Main entry point for ALL admin panel data modifications.
 * Handles granular updates to the main 'list.json' with locking and proper CORS.
 */

import { jsonResponse, errorResponse, handleOptions } from './utils/response.js';
import { getManualModels, saveManualModel, deleteManualModel, updateModelsList } from './utils/kv.js';
import { verifyAuth } from './auth/middleware.js';

/**
 * Gelen path segmentini temizleyerek path traversal saldırılarını önler.
 * Sadece alfanümerik karakterler, tire ve alt çizgiye izin verir.
 * @param {string} segment - Temizlenecek path segmenti.
 * @returns {string} Temizlenmiş ve güvenli segment.
 */
function sanitizePathSegment(segment) {
    if (!segment) return '';
    // Baştaki '/' karakterini kaldır ve sadece güvenli karakterlere izin ver.
    return segment.replace(/^\//, '').replace(/[^a-zA-Z0-9-_]/g, '');
}


// --- Cache Purge Utility ---
async function purgeEdgeCache(request, opId) {
    try {
        const cache = caches.default;
        // Dynamically build the cache URL from the incoming request origin
        const cacheUrl = new URL(request.url);
        cacheUrl.pathname = '/models.json';
        const cacheKey = new Request(cacheUrl.toString());

        const found = await cache.delete(cacheKey);
        if (found) {
            console.log(`✅ [${opId}] Edge Cache for /models.json purged successfully.`);
        } else {
            console.warn(`⚠️ [${opId}] Edge Cache for /models.json was not found (normal if expired).`);
        }
    } catch (err) {
        console.error(`❌ [${opId}] CRITICAL: Failed to purge Edge Cache: ${err.message}`);
    }
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return handleOptions(request);
        }

        const url = new URL(request.url);
        // The path will now be what comes AFTER '/curated'
        // e.g., for '.../curated/update-list', path is '/update-list'
        // e.g., for '.../curated/model-123', path is '/model-123'
        // e.g., for '.../curated', path is '/'
        const path = url.pathname.startsWith('/curated') 
    ? url.pathname.substring('/curated'.length) || '/' 
    : url.pathname;
        const kv = env.MODELS_JSON;
        const opId = `curator-${Date.now()}`;

        try {
            // --- Public Route (GET /curated) ---
            if (path === '/' && request.method === 'GET') {
                const models = await getManualModels(kv);
                return jsonResponse(models, 200, request);
            }

            // --- Protected Routes ---
            const authResult = await verifyAuth(request, env);
            if (!authResult.authorized) {
                return errorResponse(authResult.error, 403, request);
            }

            // --- Granular Update (POST /curated/update-list) ---
            if (path === '/update-list' && request.method === 'POST') {
                const updatePayload = await request.json();
                await updateModelsList(kv, env.LOCKS, updatePayload, opId);
                ctx.waitUntil(purgeEdgeCache(request, opId));
                return jsonResponse({ success: true, message: `Data updated successfully.` }, 200, request);
            }

            // --- Create a new model (POST /curated) ---
            if (path === '/' && request.method === 'POST') {
                const modelData = await request.json();
                await saveManualModel(kv, env.LOCKS, modelData, opId, false);
                ctx.waitUntil(purgeEdgeCache(request, opId));
                return jsonResponse({ success: true, message: `Model '${modelData.id}' saved successfully.` }, 201, request);
            }

            // --- Update a model (PUT /curated/:id) ---
            if (request.method === 'PUT' && path.startsWith('/') && path.length > 1) {
                 const modelId = sanitizePathSegment(path);
                 if (!modelId) {
                    return errorResponse("Invalid model ID provided.", 400, request);
                 }
                 const modelData = await request.json();
                 // ID'nin payload içinde de tutarlı olmasını sağla
                 if (modelData.id !== modelId) {
                    return errorResponse(`Model ID in URL ('${modelId}') does not match payload ID ('${modelData.id}').`, 400, request);
                 }
                 await saveManualModel(kv, env.LOCKS, modelData, opId, true);
                 ctx.waitUntil(purgeEdgeCache(request, opId));
                 return jsonResponse({ success: true, message: `Model '${modelData.id}' updated successfully.` }, 200, request);
            }

            // --- Delete a model (DELETE /curated/:id) ---
            if (request.method === 'DELETE' && path.startsWith('/') && path.length > 1) {
                const modelId = sanitizePathSegment(path);
                if (!modelId) {
                    return errorResponse("Invalid or unsafe model ID provided.", 400, request);
                }
                await deleteManualModel(kv, env.LOCKS, modelId, opId);
                ctx.waitUntil(purgeEdgeCache(request, opId));
                return jsonResponse({ success: true, message: `Model '${modelId}' deleted.` }, 200, request);
            }
            
            return errorResponse("Curator endpoint not found or method not allowed.", 404, request);

        } catch (e) {
            console.error(`[CURATOR_WORKER] Unhandled Error: ${e.message}`, e.stack);
            const status = e.status || 500;
            const message = e.message || "An internal server error occurred.";
            return errorResponse(message, status, request);
        }
    },
};