import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importPKCS8, SignJWT } from 'jose';
import { verifyAuth } from '../auth/middleware.js';

const project = 'vertex-ai-1618';
const env = { FIREBASE_PROJECT_ID: project };
const directory = mkdtempSync(join(tmpdir(), 'curator-console-test-'));
let certificate, key;
try {
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-x509', '-nodes', '-subj', '/CN=Fixture',
        '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    certificate = readFileSync(join(directory, 'cert.pem'), 'utf8');
    key = await importPKCS8(readFileSync(join(directory, 'key.pem'), 'utf8'), 'RS256');
} finally {
    rmSync(directory, { recursive: true, force: true });
}

async function request(admin, audience = project) {
    const token = await new SignJWT({ admin })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
        .setSubject('test-fixture')
        .setAudience(audience)
        .setIssuer(`https://securetoken.google.com/${project}`)
        .setExpirationTime('1m')
        .sign(key);
    return new Request('https://fixture.invalid/curated/test', { headers: { Authorization: `Bearer ${token}` } });
}

test('Curator uses current Core access, rejects revoked claims and fails closed on outage', async (t) => {
    let outcome = Response.json({ result: { isCore: true } });
    let lookups = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url.startsWith('https://www.googleapis.com/')) return Response.json({ 'fixture-key': certificate });
        assert.equal(url, `https://europe-west1-${project}.cloudfunctions.net/getMyConsoleAccess`);
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { data: {} });
        assert.equal(options.redirect, 'error');
        assert.match(options.headers.Authorization, /^Bearer /);
        lookups++;
        return outcome;
    });
    assert.equal((await verifyAuth(await request(false), env)).authorized, true);
    outcome = Response.json({ result: { isCore: false } });
    assert.equal((await verifyAuth(await request(true), env)).authorized, false);
    assert.equal((await verifyAuth(await request(true, 'other-project'), env)).authorized, false);
    assert.equal(lookups, 2);
    outcome = new Response(null, { status: 503 });
    assert.deepEqual(await verifyAuth(await request(true), env), {
        authorized: false,
        status: 503,
        error: 'Console access verification is temporarily unavailable.',
    });
});
