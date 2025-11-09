/*
 * Cortex Curator Worker - Authentication Middleware
 * Verifies Firebase ID Tokens using the 'jose' library with dynamic key lookup.
 */

import { jwtVerify, importX509 } from 'jose';

// --- Caching for Google's Public Keys ---
let certCache = null;
let certCacheTimestamp = 0;

async function getGoogleCerts() {
    const now = Date.now();
    // Cache for 1 hour
    if (certCache && (now - certCacheTimestamp < 3600 * 1000)) {
        return certCache;
    }

    console.log("Fetching and caching Google public keys...");
    const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!response.ok) {
        throw new Error('Failed to fetch Google public keys for token verification.');
    }
    const data = await response.json();
    certCache = data;
    certCacheTimestamp = now;
    return certCache;
}

/**
 * Verifies the Firebase ID token from the Authorization header.
 * @param {Request} request The incoming request.
 * @param {Object} env The worker environment variables.
 * @returns {Promise<{authorized: boolean, error?: string, token?: Object}>} An object indicating auth status.
 */
export async function verifyAuth(request, env) {
    if (!env.FIREBASE_PROJECT_ID) {
        console.error("CRITICAL: FIREBASE_PROJECT_ID environment variable is not set.");
        return { authorized: false, error: "Authentication service is misconfigured." };
    }
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { authorized: false, error: "Authorization header missing or invalid." };
    }
    const token = authHeader.substring(7);

    // Dynamic key lookup function for 'jose'
    const keyLookup = async (protectedHeader) => {
        if (!protectedHeader.kid) {
            throw new Error("Token is missing a 'kid' (Key ID) in its header.");
        }
        const certs = await getGoogleCerts();
        const pem = certs[protectedHeader.kid];
        if (!pem) {
            throw new Error(`No matching public key found for Key ID: ${protectedHeader.kid}`);
        }
        return importX509(pem, 'RS256');
    };

    try {
        const { payload } = await jwtVerify(token, keyLookup, {
            issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
            audience: env.FIREBASE_PROJECT_ID,
        });

        if (payload && payload.admin === true) {
            return { authorized: true, token: payload };
        }

        return { authorized: false, error: "Token is valid but does not have admin privileges." };

    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { authorized: false, error: "Token verification failed. The token may be expired, malformed, or invalid." };
    }
}