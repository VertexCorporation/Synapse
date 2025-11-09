/*
 * Cortex Supervisor Worker - v1.0 (Modular)
 * Main entry point for the data enrichment worker.
 * Delegates incoming scheduled and fetch events to specialized modules.
 *
 * Environment Variables:
 * - MODELS_JSON, LOCKS: KV Namespace bindings.
 * - VERBOSE_LOGGING: 'true' for debug logs.
 * - OPENROUTER_KEY, GOOGLE_TRANSLATE_API_KEY, SUPERVISOR_API_KEY: API secrets.
 * - (See config/constants.js for other optional env vars)
 */
import { handleScheduled } from './core/main.js';
import { handleFetch } from './http/routes.js';

export default {
    /**
     * Handles scheduled events (e.g., cron triggers).
     */
    async scheduled(event, env, ctx) {
        const opId = `sched-${event.cron.replace(/\s/g, '_')}-${Date.now()}`;
        console.log(`🛰️  [${opId}] SUPERVISOR SCHEDULED TRIGGER. Cron: "${event.cron}".`);
        // We use waitUntil to ensure the task runs to completion even if the trigger event finishes.
        ctx.waitUntil(handleScheduled(env, ctx));
    },

    /**
     * Handles incoming HTTP requests for status and maintenance endpoints.
     */
    async fetch(request, env, ctx) {
        return handleFetch(request, env, ctx);
    }
};