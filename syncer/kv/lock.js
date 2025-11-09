/*
 * Cortex - Syncer Worker - v7.0 (Modular)
 *
 * Module: KV Lock Manager
 * Description: Manages distributed locking using Cloudflare KV to ensure process exclusivity.
 * Prevents race conditions between different worker instances (e.g., syncer and supervisor).
 */

import { DEFAULTS } from '../config.js';
import { noopKV } from '../utils/helpers.js';

/**
 * Attempts to acquire a distributed lock.
 * @param {KVNamespace} kv - The LOCKS KV namespace binding.
 * @param {string} opId - The unique ID of the current operation, used as the lock holder's identifier.
 * @param {string} lockKey - The key in KV to use for the lock (e.g., "syncer_lock").
 * @returns {Promise<boolean>} A promise that resolves to `true` if the lock was acquired, `false` otherwise.
 */
export async function acquireLock(kv, opId, lockKey) {
    const LOCKS_KV = kv ?? noopKV;
    const lockTTL = DEFAULTS.LOCK_TTL_S;

    if (LOCKS_KV === noopKV) {
        console.warn(`[${opId}] LOCKS KV is not available. Proceeding without lock.`);
        return true; // In no-op mode, always "acquire" the lock.
    }

    try {
        const currentHolder = await LOCKS_KV.get(lockKey);
        if (currentHolder !== null) {
            console.log(`🔒 [${opId}] Lock "${lockKey}" is currently held by: ${currentHolder}. Skipping run.`);
            return false;
        }

        // Attempt to claim the lock
        await LOCKS_KV.put(lockKey, opId, { expirationTtl: lockTTL });
        
        // Short delay to allow for KV propagation, then verify we are the holder.
        await new Promise(resolve => setTimeout(resolve, 250));
        
        const newHolder = await LOCKS_KV.get(lockKey);
        if (newHolder === opId) {
            console.log(`🔑 [${opId}] ACQUIRED lock "${lockKey}" for ${lockTTL}s.`);
            return true;
        } else {
            console.log(`[${opId}] Lock contention for "${lockKey}". Another instance (${newHolder}) acquired it first.`);
            return false;
        }
    } catch (e) {
        console.error(`❌ [${opId}] CRITICAL ERROR during lock acquisition for "${lockKey}": ${e.message}`);
        return false;
    }
}

/**
 * Releases a previously acquired distributed lock.
 * This should be called in a 'finally' block to ensure the lock is always released.
 * @param {KVNamespace} kv - The LOCKS KV namespace binding.
 * @param {string} opId - The operation ID for logging.
 * @param {string} lockKey - The key in KV of the lock to release.
 * @param {object} [context] - The worker execution context, for `waitUntil`.
 */
export async function releaseLock(kv, opId, lockKey, context) {
    const LOCKS_KV = kv ?? noopKV;
    if (LOCKS_KV === noopKV) return;

    const release = async () => {
        try {
            await LOCKS_KV.delete(lockKey);
            console.log(`🔑 [${opId}] Lock "${lockKey}" RELEASED.`);
        } catch (e) {
            console.warn(`⚠️ [${opId}] Failed to delete lock "${lockKey}": ${e.message}. It will expire via TTL.`);
        }
    };

    if (context?.waitUntil) {
        context.waitUntil(release());
    } else {
        await release();
    }
}