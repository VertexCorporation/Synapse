/*
 * Deterministic test driver for the syncer suite.
 *
 * Why this exists instead of `node --test tests/*.test.js`:
 * Node v22.x's built-in test runner mis-frames a child's event stream when
 * a test (or library code it exercises) writes NON-ASCII stdout — our sync
 * log lines are emoji-tagged (loudspeaker/alarm/warning/cloud markers) —
 * and then either drops the whole file's results or crashes the parent with
 * "Unable to deserialize cloned data due to invalid or unsupported version."
 * See nodejs/node#65934 (fix #64706 exists on main/v24+, no v22.x backport).
 *
 * This driver runs each test file as a plain `node <file>` child: identical
 * per-file process isolation and TAP output, but the buggy parent parser is
 * bypassed entirely. Each child's exit code is the source of truth.
 *
 * Usage: npm test
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tests');
const files = readdirSync(testsDir)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => join(testsDir, f));

const failed = [];
for (const file of files) {
    const label = `tests/${file.slice(file.lastIndexOf('/') + 1)}`;
    process.stdout.write(`\n=== ${label} ===\n`);
    const res = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    if (res.error) {
        process.stdout.write(`spawn failed: ${res.error.message}\n`);
        failed.push(`${label} (spawn error)`);
    } else if (res.status !== 0) {
        failed.push(`${label} (exit ${res.status}${res.signal ? ', ' + res.signal : ''})`);
    }
}

process.stdout.write(`\n=== summary: ${files.length - failed.length}/${files.length} files passed ===\n`);
for (const f of failed) process.stdout.write(`FAILED: ${f}\n`);
process.exit(failed.length === 0 ? 0 : 1);
