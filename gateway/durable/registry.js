/*
 * Gateway - Registry Durable Object (singleton)
 * Maps member keys (hashed) to members. One active key per member; issuing a new one revokes the old.
 */

import { DurableObject } from 'cloudflare:workers';

const KEY_PREFIX = 'key:';
const MEMBER_PREFIX = 'member:';

export class Registry extends DurableObject {
    /**
     * Resolves a key hash to its member.
     * @param {string} keyHash
     * @returns {Promise<{email: string, active: boolean, limitUsd: number|null}|null>}
     */
    async lookup(keyHash) {
        const ref = await this.ctx.storage.get(KEY_PREFIX + keyHash);
        if (!ref) return null;
        const member = await this.ctx.storage.get(MEMBER_PREFIX + ref.email);
        if (!member || member.keyHash !== keyHash) return null;
        return { email: member.email, active: member.active !== false, limitUsd: member.limitUsd ?? null };
    }

    async getMember(email) {
        return (await this.ctx.storage.get(MEMBER_PREFIX + email)) || null;
    }

    /**
     * Creates a member or rotates their key.
     * @param {{email: string, keyHash: string, limitUsd?: number|null, actor?: string}} input
     */
    async upsertMember({ email, keyHash, limitUsd = null, actor = null }) {
        const now = new Date().toISOString();
        const existing = await this.ctx.storage.get(MEMBER_PREFIX + email);
        const record = {
            email,
            keyHash,
            active: true,
            limitUsd: limitUsd ?? existing?.limitUsd ?? null,
            createdAt: existing?.createdAt || now,
            createdBy: existing?.createdBy || actor,
            rotatedAt: existing ? now : null,
            rotatedBy: existing ? actor : null,
        };
        await this.ctx.storage.transaction(async (txn) => {
            if (existing && existing.keyHash && existing.keyHash !== keyHash) {
                await txn.delete(KEY_PREFIX + existing.keyHash);
            }
            await txn.put(KEY_PREFIX + keyHash, { email });
            await txn.put(MEMBER_PREFIX + email, record);
        });
        return record;
    }

    /**
     * @param {string} email
     * @param {{active?: boolean, limitUsd?: number|null}} patch
     */
    async updateMember(email, patch) {
        const existing = await this.ctx.storage.get(MEMBER_PREFIX + email);
        if (!existing) return null;
        const record = { ...existing };
        if (typeof patch.active === 'boolean') record.active = patch.active;
        if ('limitUsd' in patch) record.limitUsd = patch.limitUsd;
        record.updatedAt = new Date().toISOString();
        await this.ctx.storage.put(MEMBER_PREFIX + email, record);
        return record;
    }

    async listMembers() {
        const map = await this.ctx.storage.list({ prefix: MEMBER_PREFIX });
        return Array.from(map.values()).sort((a, b) => a.email.localeCompare(b.email));
    }
}
