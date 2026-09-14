/*
 * Gateway - Admin authentication
 * /admin routes accept either the ADMIN_TOKEN secret (scripts, curl) or a Firebase ID token whose
 * custom claims carry `admin: true` (the admin panel). Firebase verification mirrors the curator worker.
 */

import { jwtVerify, importX509 } from 'jose';
import { safeEqual } from './keys.js';

let certCache = null;
let certCacheTimestamp = 0;

async function getGoogleCerts() {
    const now = Date.now();
    if (certCache && (now - certCacheTimestamp < 3600 * 1000)) return certCache;
    const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!response.ok) throw new Error('Failed to fetch Google public keys for token verification.');
    certCache = await response.json();
    certCacheTimestamp = now;
    return certCache;
}

async function verifyFirebaseAdmin(token, env) {
    if (!env.FIREBASE_PROJECT_ID) return { ok: false, error: 'Authentication service is misconfigured.' };
    const keyLookup = async (protectedHeader) => {
        if (!protectedHeader.kid) throw new Error("Token is missing a 'kid' in its header.");
        const certs = await getGoogleCerts();
        const pem = certs[protectedHeader.kid];
        if (!pem) throw new Error(`No matching public key for kid ${protectedHeader.kid}`);
        return importX509(pem, 'RS256');
    };
    try {
        const { payload } = await jwtVerify(token, keyLookup, {
            issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
            audience: env.FIREBASE_PROJECT_ID,
        });
        if (payload && payload.admin === true) {
            return { ok: true, actor: payload.email || payload.sub, via: 'firebase' };
        }
        return { ok: false, error: 'Token is valid but does not carry admin privileges.' };
    } catch (e) {
        return { ok: false, error: `Token verification failed: ${e.message}` };
    }
}

/**
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<{ok: boolean, actor?: string, via?: string, error?: string}>}
 */
export async function verifyAdmin(request, env) {
    const header = request.headers.get('Authorization') || '';
    if (!/^Bearer\s+/i.test(header)) return { ok: false, error: 'Authorization header missing or invalid.' };
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) return { ok: false, error: 'Authorization header missing or invalid.' };

    if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
        return { ok: true, actor: 'admin-token', via: 'token' };
    }
    // Firebase ID tokens are JWTs (three dot-separated segments); anything else is a plain wrong token.
    if (token.split('.').length === 3) {
        return verifyFirebaseAdmin(token, env);
    }
    return { ok: false, error: 'Invalid admin credential.' };
}
