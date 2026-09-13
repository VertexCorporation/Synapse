/*
 * Gateway - Usage extraction
 * Reads token usage out of OpenAI-shaped JSON bodies and SSE streams without altering the bytes
 * that flow back to the client. Also counts the characters of generated text so a response that
 * arrives without a usage block can still be estimated instead of going unbilled.
 */

function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Characters of assistant text carried by one JSON object (a full response or one SSE chunk).
 */
export function contentChars(obj) {
    if (!obj || !Array.isArray(obj.choices)) return 0;
    let chars = 0;
    for (const choice of obj.choices) {
        const delta = choice?.delta?.content;
        const message = choice?.message?.content;
        if (typeof delta === 'string') chars += delta.length;
        if (typeof message === 'string') chars += message.length;
        const text = choice?.text;
        if (typeof text === 'string') chars += text.length;
    }
    return chars;
}

/**
 * Pulls whatever usage information a single JSON object carries.
 * @param {any} obj Parsed JSON (a full response or one SSE event).
 * @returns {{promptTokens: number|null, completionTokens: number|null, neurons: number|null, id: string|null, model: string|null, chars: number}|null}
 */
export function extractUsage(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
    const id = typeof obj.id === 'string' ? obj.id : null;
    const model = typeof obj.model === 'string' ? obj.model : null;
    const chars = contentChars(obj);
    if (!usage && !id && !model && !chars) return null;
    return {
        promptTokens: usage ? (num(usage.prompt_tokens) ?? num(usage.input_tokens)) : null,
        completionTokens: usage ? (num(usage.completion_tokens) ?? num(usage.output_tokens)) : null,
        neurons: usage ? num(usage.neurons) : null,   // Workers AI's own billing unit, when reported
        id,
        model,
        chars,
    };
}

/**
 * Merges a newly seen usage fragment into a running summary. Token counts never go down
 * (streams report them cumulatively); characters accumulate; id/model stick once seen.
 */
export function mergeUsage(summary, fragment) {
    if (!fragment) return summary;
    const out = { ...summary };
    if (fragment.promptTokens != null) out.promptTokens = Math.max(out.promptTokens ?? 0, fragment.promptTokens);
    if (fragment.completionTokens != null) out.completionTokens = Math.max(out.completionTokens ?? 0, fragment.completionTokens);
    if (fragment.neurons != null) out.neurons = Math.max(out.neurons ?? 0, fragment.neurons);
    out.chars += fragment.chars || 0;
    if (!out.id && fragment.id) out.id = fragment.id;
    if (fragment.model) out.model = fragment.model;
    return out;
}

export function emptyUsage() {
    return { promptTokens: null, completionTokens: null, neurons: null, id: null, model: null, chars: 0 };
}

/**
 * Incremental SSE scanner. Feed it raw bytes; it tracks `data:` lines across chunk boundaries.
 */
export class UsageScanner {
    constructor() {
        this.decoder = new TextDecoder();
        this.buffer = '';
        this.summary = emptyUsage();
        this.events = 0;
    }

    feed(chunk) {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        this.drain(false);
    }

    finish() {
        this.buffer += this.decoder.decode();
        this.drain(true);
        return this.summary;
    }

    drain(final) {
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            this.consumeLine(line);
        }
        if (final && this.buffer) {
            this.consumeLine(this.buffer);
            this.buffer = '';
        }
    }

    consumeLine(rawLine) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
            const obj = JSON.parse(payload);
            this.events += 1;
            this.summary = mergeUsage(this.summary, extractUsage(obj));
        } catch {
            // Partial or non-JSON data line; ignore.
        }
    }
}

/**
 * Splits a response body: one branch goes to the client untouched, the other is read to the end
 * by the usage scanner. Reading the second branch independently means the account is settled even
 * when the client disconnects mid-stream (the upstream generation is billed either way).
 * @param {ReadableStream<Uint8Array>} body
 * @returns {{clientBody: ReadableStream<Uint8Array>, summary: Promise<ReturnType<typeof emptyUsage>>}}
 */
export function meterStream(body) {
    const [clientBody, meterBody] = body.tee();
    const summary = (async () => {
        const scanner = new UsageScanner();
        const reader = meterBody.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                scanner.feed(value);
            }
        } catch (e) {
            console.warn('[GATEWAY] upstream stream ended abnormally:', e.message);
        }
        return scanner.finish();
    })();
    return { clientBody, summary };
}
