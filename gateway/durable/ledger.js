/*
 * Gateway - Ledger Durable Object (one per member)
 * Keeps month-by-month spend. A Durable Object is single-threaded per member, so concurrent
 * requests cannot lose updates the way a read-modify-write on KV would.
 */

import { DurableObject } from 'cloudflare:workers';
import { roundUsd } from '../lib/quota.js';

const USAGE_PREFIX = 'usage:';
const MAX_MODELS_TRACKED = 50;

function emptyMonth(month) {
    return {
        month,
        spentUsd: 0,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        unpricedRequests: 0,   // requests whose cost could not be determined (counted, not charged)
        estimatedRequests: 0,  // requests charged from a character-based token estimate (no usage block upstream)
        byModel: {},
        firstAt: null,
        lastAt: null,
    };
}

export class Ledger extends DurableObject {
    async readMonth(month) {
        return (await this.ctx.storage.get(USAGE_PREFIX + month)) || emptyMonth(month);
    }

    /**
     * Budget check performed before a request is forwarded upstream.
     * Requests already in flight are not reserved; the overshoot is bounded by the cost of
     * whatever finishes concurrently, which is acceptable for a $25/month personal budget.
     * @param {{month: string, limitUsd: number}} input
     */
    async authorize({ month, limitUsd }) {
        const usage = await this.readMonth(month);
        const remainingUsd = roundUsd(Math.max(0, limitUsd - usage.spentUsd));
        return {
            ok: usage.spentUsd < limitUsd,
            spentUsd: roundUsd(usage.spentUsd),
            limitUsd,
            remainingUsd,
        };
    }

    /**
     * Records a finished request.
     * @param {{month: string, costUsd: number|null, promptTokens?: number|null, completionTokens?: number|null, model?: string|null, estimated?: boolean}} input
     */
    async settle({ month, costUsd, promptTokens = null, completionTokens = null, model = null, estimated = false }) {
        const usage = await this.readMonth(month);
        const now = new Date().toISOString();
        const priced = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0;

        usage.requests += 1;
        if (priced) usage.spentUsd = roundUsd(usage.spentUsd + costUsd);
        else usage.unpricedRequests += 1;
        if (priced && estimated) usage.estimatedRequests = (usage.estimatedRequests || 0) + 1;
        if (promptTokens) usage.promptTokens += promptTokens;
        if (completionTokens) usage.completionTokens += completionTokens;
        if (model) {
            const known = Object.keys(usage.byModel);
            if (known.includes(model) || known.length < MAX_MODELS_TRACKED) {
                const entry = usage.byModel[model] || { requests: 0, spentUsd: 0 };
                entry.requests += 1;
                if (priced) entry.spentUsd = roundUsd(entry.spentUsd + costUsd);
                usage.byModel[model] = entry;
            }
        }
        usage.firstAt = usage.firstAt || now;
        usage.lastAt = now;

        await this.ctx.storage.put(USAGE_PREFIX + month, usage);
        return usage;
    }

    async status({ month }) {
        const usage = await this.readMonth(month);
        return { ...usage, spentUsd: roundUsd(usage.spentUsd) };
    }

    async history() {
        const map = await this.ctx.storage.list({ prefix: USAGE_PREFIX });
        return Array.from(map.values()).sort((a, b) => b.month.localeCompare(a.month));
    }
}
