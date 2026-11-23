/*
 * Gateway - Member key helpers
 * Keys are shown once at creation; only their SHA-256 hash is stored.
 */

export const KEY_PREFIX = 'vxg_';

function toBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates a new random member key (32 bytes of entropy).
 * @returns {string}
 */
export function generateKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return KEY_PREFIX + toBase64Url(bytes);
}

/**
 * SHA-256 hex digest of a key.
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function hashKey(key) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pulls the caller's credential out of the request.
 * Accepts `Authorization: Bearer <key>` (OpenAI SDKs) and `x-api-key: <key>` (Anthropic SDKs).
 * @param {Request} request
 * @returns {string|null}
 */
export function extractCredential(request) {
    const auth = request.headers.get('Authorization');
    if (auth && /^Bearer\s+/i.test(auth)) {
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token) return token;
    }
    const apiKey = request.headers.get('x-api-key');
    if (apiKey && apiKey.trim()) return apiKey.trim();
    return null;
}

/**
 * Constant-time string comparison.
 */
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const enc = new TextEncoder();
    const ab = enc.encode(a);
    const bb = enc.encode(b);
    if (ab.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
    return diff === 0;
}

/**
 * Lower-cases and validates an email used as the member identity.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
