/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: Main Entry Point
 * Description: The primary entry point for the Cloudflare Worker.
 * It routes scheduled events and fetch requests to the appropriate core logic modules.
 */

import { syncModels } from './core/sync.js';
import { serveModelsJson } from './core/serve.js';

console.log(`***** SYNC WORKER (MODULAR) v7.0 STARTING - ${new Date().toISOString()} *****`);

export default {
    /**
     * Handles scheduled events (e.g., cron triggers).
     */
    async scheduled(event, env, ctx) {
        const opId = `scheduled-${event.cron.replace(/\s/g, "_")}-${Date.now()}`;
        console.log(`⏰ [${opId}] Scheduled trigger received. Cron: "${event.cron}"`);
        
        ctx.waitUntil(
            syncModels(env, ctx).catch((e) =>
                console.error(`❌ [${opId}] Unhandled fatal error in scheduled syncModels: ${e.name} - ${e.message}`, e.stack?.substring(0, 500))
            )
        );
    },

    /**
     * Handles incoming HTTP requests.
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        if (url.pathname === "/models" || url.pathname === "/models.json") {
            return serveModelsJson(env, request, ctx);
        }
        
        return new Response("Cortex Syncer Worker: Endpoint not found.", { status: 404 });
    },
};