/*
 * Cortex Supervisor Worker - HTTP Router
 * Handles incoming fetch requests, authenticates, and routes them to the correct handler.
 */
import { getSettings } from '../config/settings.js';
import { createLogger } from '../utils/logger.js';
import { noopKV } from '../utils/helpers.js';
import { acquireLock, releaseLock, getLockHolder } from '../kv/lock.js';
import { generateSystemStatus } from './handlers/status.js';
import { performCleanup } from './handlers/cleanup.js';

/**
 * The main fetch event handler for the Supervisor worker.
 * @param {Request} request The incoming request.
 * @param {object} env The worker's environment object.
 * @param {object} context The execution context.
 * @returns {Promise<Response>}
 */
export async function handleFetch(request, env, context) {
    const url = new URL(request.url);
    const settings = getSettings(env);
    const opId = `req-${url.pathname.replace(/\//g, '_')}-${Date.now()}`;
    const logger = createLogger(settings.isVerboseLogging, opId);
    
    // --- Authentication ---
    const apiKey = request.headers.get('X-API-Key');
    if (!settings.supervisorApiKey || apiKey !== settings.supervisorApiKey) {
        return new Response('Forbidden', { status: 403 });
    }
    
    const modelsKv = env.MODELS_JSON;
    const locksKv = env.LOCKS ?? noopKV;

    // --- Routing ---
    try {
        if (url.pathname === '/status' && request.method === 'GET') {
            const statusReport = await generateSystemStatus(modelsKv, locksKv, settings);
            return new Response(JSON.stringify(statusReport, null, 2), { headers: { 'Content-Type': 'application/json' } });
        }

        if (url.pathname === '/maintenance/cleanup-corrupted-descriptions' && request.method === 'POST') {
            return await handleCleanupRequest(modelsKv, locksKv, settings, logger, opId, context);
        }

        return new Response('Endpoint not found or method not allowed.', { status: 404 });
    } catch (error) {
        logger.error(`[ROUTER] Unhandled fetch error: ${error.message}`, error.stack);
        return new Response(JSON.stringify({ status: 'error', message: 'Internal Server Error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

/**
 * A dedicated handler for the cleanup request to manage locking.
 */
async function handleCleanupRequest(modelsKv, locksKv, settings, logger, opId, context) {
    const cleanupLockKey = "cleanup_lock";
    
    // Check if other critical processes are running
    const supervisorHolder = await getLockHolder(locksKv, "supervisor_lock");
    const syncerHolder = await getLockHolder(locksKv, "syncer_lock");

    if (supervisorHolder || syncerHolder) {
        const busy = [supervisorHolder && `Supervisor`, syncerHolder && `Syncer`].filter(Boolean).join(' & ');
        const message = `Cannot start cleanup. System is busy: ${busy}.`;
        logger.warn(message);
        return new Response(JSON.stringify({ status: "error", message }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    const lockAcquired = await acquireLock(locksKv, cleanupLockKey, opId, 60, logger);
    if (!lockAcquired) {
        const message = `Could not acquire cleanup lock. Another cleanup process may be running.`;
        logger.warn(message);
        return new Response(JSON.stringify({ status: "error", message }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    
    try {
        const result = await performCleanup(modelsKv, settings, logger, opId);
        return new Response(JSON.stringify(result), { status: result.status === 'success' ? 200 : 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
        context.waitUntil(releaseLock(locksKv, cleanupLockKey, logger));
    }
}