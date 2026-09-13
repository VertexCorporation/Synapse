/*
 * Gateway - Usage extraction
 * Reads OpenRouter usage blocks out of JSON bodies and SSE streams without altering the bytes
 * that flow back to the client. Understands the OpenAI chat/completions shape, the Anthropic
 * messages shape (message_start / message_delta events) and the Responses API shape.
 */

function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pulls whatever usage information a single JSON object carries.
 * @param {any} obj Parsed JSON (a full response or one SSE event).
 * @returns {{cost: number|null, promptTokens: number|null, completionTokens: number|null, id: string|null, model: string|null}|null}
 */
export function extractUsage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // Anthropic streams wrap the message in `message`; the Responses API wraps it in `response`.
    const carrier = obj.message && typeof obj.message === 'object' ? obj.message
        : obj.response && typeof obj.response === 'object' ? obj.response
        : obj;

    const usage = (carrier.usage && typeof carrier.usage === 'object') ? carrier.usage
        : (obj.usage && typeof obj.usage === 'object') ? obj.usage
        : null;

    const id = typeof carrier.id === 'string' ? carrier.id : (typeof obj.id === 'string' ? obj.id : null);
    const model = typeof carrier.model === 'string' ? carrier.model : (typeof obj.model === 'string' ? obj.model : null);

    if (!usage && !id && !model) return null;

    return {
        cost: usage ? num(usage.cost) : null,
        promptTokens: usage ? (num(usage.prompt_tokens) ?? num(usage.input_tokens)) : null,
        completionTokens: usage ? (num(usage.completion_tokens) ?? num(usage.output_tokens)) : null,
        id,
        model,
    };
}

/**
 * Merges a newly seen usage fragment into a running summary. Later values win, except that
 * an id/model is kept once seen and token counts never go down (streams report them cumulatively).
 */
export function mergeUsage(summary, fragment) {
    if (!fragment) return summary;
    const out = { ...summary };
    if (fragment.cost != null) out.cost = fragment.cost;
    if (fragment.promptTokens != null) out.promptTokens = Math.max(out.promptTokens ?? 0, fragment.promptTokens);
    if (fragment.completionTokens != null) out.completionTokens = Math.max(out.completionTokens ?? 0, fragment.completionTokens);
    if (!out.id && fragment.id) out.id = fragment.id;
    if (fragment.model) out.model = fragment.model;
    return out;
}

export function emptyUsage() {
    return { cost: null, promptTokens: null, completionTokens: null, id: null, model: null };
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
