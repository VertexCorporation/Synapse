/*
 * Cortex Curator Worker - v1.0 (Modular)
 * Main entry point for the manual models API worker.
 * Handles routing and delegates logic to specialized modules.
 *
 * Environment Variables:
 * - MODELS_JSON: KV Namespace binding for storing manual model data.
 * - FIREBASE_PROJECT_ID: Your Firebase project ID.
 */

import { jsonResponse, errorResponse, handleOptions } from './utils/response.js';
import { getManualModels, saveManualModel, deleteManualModel } from './utils/kv.js';
import { verifyAuth } from './auth/middleware.js';

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return handleOptions(request);
        }

        const url = new URL(request.url);
        const path = url.pathname;
        const kv = env.MODELS_JSON;

        try {
            // --- Public Route (No Auth Required) ---
            if (path === '/' && request.method === 'GET') {
                const models = await getManualModels(kv);
                return jsonResponse(models, 200, request);
            }

            // --- Protected Routes (Auth Required) ---
            const authResult = await verifyAuth(request, env);
            if (!authResult.authorized) {
                return errorResponse(authResult.error, 403, request);
            }

            // POST to create a new model
            if (path === '/' && request.method === 'POST') {
                const modelData = await request.json();
                await saveManualModel(kv, modelData);
                return jsonResponse({ success: true, message: `Model '${modelData.id}' saved successfully.` }, 201, request);
            }

            // DELETE to remove a model
            if (request.method === 'DELETE') {
                const pathParts = url.pathname.split('/');
                const modelId = pathParts.pop() || pathParts.pop();

                await deleteManualModel(kv, modelId);
                return jsonResponse({ success: true, message: `Model '${modelId}' deleted.` }, 200, request);
            }

            // Fallback for unmatched routes
            return errorResponse("Endpoint not found or method not allowed.", 404, request);

        } catch (e) {
            console.error("[CURATOR_WORKER] Unhandled Error:", e);
            const status = e.status || 500;
            const message = status === 500 ? "An internal server error occurred." : e.message;
            return errorResponse(message, status, request);
        }
    },
};