/*
 * Cortex Supervisor Worker - KV Lock Manager
 * Handles acquiring, checking, and releasing locks using a KV namespace.
 * This prevents concurrent runs of critical processes like Supervisor and Syncer.
 */

/**
 * Attempts to acquire a lock by writing an identifier to a key with a TTL.
 * @param {KVNamespace} kv The LOCKS KV namespace.
 * an object with lock info.
 * @param {string} lockKey The key to use for the lock (e.g., "supervisor_lock").
 * @param {string} instanceId The unique ID of the current worker instance.
 * @param {number} ttlSeconds The time-to-live for the lock in seconds.
 * @param {object} logger A logger instance.
 * @returns {Promise<boolean>} True if the lock was acquired, false otherwise.
 */
export async function acquireLock(kv, lockKey, instanceId, ttlSeconds, logger) {
    logger.debug(`[LOCK] Attempting to acquire lock "${lockKey}" for ${ttlSeconds}s...`);
    try {
        const currentHolder = await kv.get(lockKey);
        if (currentHolder === null) {
            // No current lock holder, try to acquire it.
            await kv.put(lockKey, instanceId, { expirationTtl: ttlSeconds });
            
            // Short delay to mitigate race conditions in eventual consistency environments.
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // Verify that *we* actually got the lock.
            const newHolder = await kv.get(lockKey);
            if (newHolder === instanceId) {
                logger.debug(`🔑 [LOCK] ACQUIRED: "${lockKey}".`);
                return true;
            }
            logger.debug(`[LOCK] Contention for "${lockKey}". Instance "${newHolder}" acquired it.`);
            return false;
        } else {
            logger.debug(`🔒 [LOCK] Lock "${lockKey}" HELD by: ${currentHolder}.`);
            return false;
        }
    } catch (e) {
        logger.error(`❌ [LOCK] Error during lock acquisition for "${lockKey}": ${e.message}`);
        return false;
    }
}

/**
 * Releases a previously acquired lock by deleting the key.
 * @param {KVNamespace} kv The LOCKS KV namespace.
 * @param {string} lockKey The key of the lock to release.
 * @param {object} logger A logger instance.
 * @returns {Promise<void>}
 */
export async function releaseLock(kv, lockKey, logger) {
    logger.debug(`[LOCK] Releasing lock "${lockKey}"...`);
    try {
        await kv.delete(lockKey);
        logger.debug(`🔑 [LOCK] RELEASED: "${lockKey}".`);
    } catch (e) {
        logger.warn(`⚠️ [LOCK] Failed to delete lock "${lockKey}": ${e.message}. It will expire via TTL.`);
    }
}

/**
 * Checks if a specific lock is currently held.
 * @param {KVNamespace} kv The LOCKS KV namespace.
 * @param {string} lockKey The key to check.
 * @returns {Promise<string|null>} The ID of the lock holder, or null if not locked.
 */
export async function getLockHolder(kv, lockKey) {
    if (!kv || typeof kv.get !== 'function') return null;
    return await kv.get(lockKey);
}