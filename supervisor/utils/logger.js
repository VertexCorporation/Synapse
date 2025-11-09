/*
 * Cortex Supervisor Worker - Logger Utility
 * Creates a structured logger with debug capabilities.
 */

/**
 * Creates a logger instance for a specific operation.
 * Verbose (debug) logging can be enabled via the VERBOSE_LOGGING environment variable.
 * @param {boolean} isVerbose Whether to enable debug-level logging.
 * @param {string} opId The unique ID for the current operation.
 * @returns {object} A logger object with info, warn, error, and debug methods.
 */
export const createLogger = (isVerbose, opId) => {
    return {
        info: (message, ...args) => console.log(`[${opId}] ${message}`, ...args),
        warn: (message, ...args) => console.warn(`[${opId}] ⚠️  ${message}`, ...args),
        error: (message, ...args) => console.error(`[${opId}] ❌ ${message}`, ...args),
        debug: (message, ...args) => {
            if (isVerbose) {
                console.log(`[${opId}] [DEBUG] ${message}`, ...args);
            }
        }
    };
};