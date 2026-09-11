/*
 * Fixture recorder — fetches live provider payloads and writes trimmed,
 * representative fixtures into tests/fixtures/ for offline tests.
 *
 * Usage: node scripts/fetch-fixtures.mjs   (reads .dev.vars in repo root)
 * Keys are never logged or written to the fixtures.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(root, 'tests', 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

const env = {};
for (const line of readFileSync(join(root, '.dev.vars'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function get(url, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

function save(name, payload) {
    writeFileSync(join(fixturesDir, `${name}.json`), JSON.stringify(payload, null, 2));
    console.log(`✅ ${name}.json written`);
}

// --- OpenRouter (public) -------------------------------------------------
{
    const data = await get('https://openrouter.ai/api/v1/models', env.OPENROUTER_KEY ? { Authorization: `Bearer ${env.OPENROUTER_KEY}` } : {});
    const models = data.data || [];
    const wantedExact = new Set([
        'openai/gpt-oss-120b', 'openai/gpt-oss-120b:free', 'openai/gpt-4o-mini',
        'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash:free',
        'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen3-coder', 'moonshotai/kimi-k2',
        'deepseek/deepseek-r1', 'x-ai/grok-4', 'mistralai/mistral-small-3.2-24b-instruct',
        'liquid/lfm-2.5-2.6b:free',
    ]);
    const keep = models.filter(m => wantedExact.has(m.id)
        // image-output model (policy-excluded), vision model, audio model, file model
        || ['google/gemini-2.5-flash-image-preview', 'google/gemini-2.5-pro', 'openai/gpt-4o-audio-preview'].includes(m.id));
    save('openrouter', { data: keep.slice(0, 20), _total: models.length, _capturedAt: new Date().toISOString() });
}

// --- Groq ------------------------------------------------------------------
{
    const data = await get('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${env.GROQ_API_KEY || env.GROQ_KEY}` });
    save('groq', { data: (data.data || []).slice(0, 25), _total: (data.data || []).length, _capturedAt: new Date().toISOString() });
}

// --- Cloudflare Workers AI ---------------------------------------------------
{
    const accountId = env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100`;
    const data = await get(url, { Authorization: `Bearer ${token}` });
    const result = data.result || [];
    const wanted = m => /llama-3\.3|llama-3\.2-11b-vision|qwen|gpt-oss|kimi|whisper|flux|bge|m2m100|qwen3-embedding|deepseek|gemma/i.test(m.name || m.id || '');
    save('cloudflare', { result: result.filter(wanted).slice(0, 30), result_info: data.result_info, _total: result.length, _capturedAt: new Date().toISOString() });
}

// --- ElevenLabs --------------------------------------------------------------
{
    const models = await get('https://api.elevenlabs.io/v1/models', { 'xi-api-key': env.ELEVENLABS_KEY || env.ELEVENLABS_API_KEY });
    save('elevenlabs', Array.isArray(models) ? models.slice(0, 15) : models);
}

// --- Deepgram ------------------------------------------------------------------
{
    const data = await get('https://api.deepgram.com/v1/models', { Authorization: `Token ${env.DEEPGRAM_KEY || env.DEEPGRAM_API_KEY}` });
    const stt = (data.stt || []).slice(0, 8);
    const tts = (data.tts || []).slice(0, 5);
    save('deepgram', { stt, tts, _capturedAt: new Date().toISOString() });
}

// --- Fal (public, paginated) ----------------------------------------------------
{
    let items = [];
    let cursor = null;
    for (let page = 0; page < 6; page++) {
        const url = cursor ? `https://api.fal.ai/v1/models?cursor=${encodeURIComponent(cursor)}` : 'https://api.fal.ai/v1/models';
        const data = await get(url);
        items.push(...(data.models || []));
        cursor = data.has_more && data.next_cursor ? data.next_cursor : null;
        if (!cursor) break;
    }
    const wanted = m => /^fal-ai\/(flux|kling-video|minimax|veo|seedance|seedream|recraft|ideogram|playht|kokoro|ltx|wan|sdxl|fast-svd|luma|topaz|hunyuan|vidu|bria|pixverse|grok-imagine|imagen|nano-banana)/.test(m.endpoint_id || '');
    save('fal', { models: items.filter(wanted).slice(0, 60), _total: items.length, _capturedAt: new Date().toISOString() });
}

console.log('Done.');
