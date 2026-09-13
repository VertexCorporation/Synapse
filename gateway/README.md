# Gateway

A metered proxy in front of **Cloudflare Workers AI** for the **Array** department.

- **One upstream credential.** The Vertex account's `CF_API_TOKEN` lives only in the worker. Members never see it.
- **One personal key per member.** Admins issue `vxg_...` keys; the worker maps each request to a member.
- **$25 per member per calendar month** (`MONTHLY_LIMIT_USD`, overridable per member). Workers AI reports token counts, not money, so each response is priced as `tokens × the model's published USD-per-million price`. Prices come from the live Workers AI catalog (`/ai/models/search`, refreshed every 6 h), a `MODEL_PRICES` override, or a built-in snapshot of the pricing page. A model with no known price cannot be metered and is refused. Once a member's month-to-date spend reaches the limit, further requests get `402 budget_exhausted` until the 1st of the next month (`QUOTA_TIMEZONE`, default Europe/Istanbul).
- **Durable Objects, no KV.** `Registry` (one object) maps key hashes to members and caches the price catalog; `Ledger` (one object per member) keeps the month-by-month ledger. Per-member objects are single-threaded, so concurrent requests cannot lose updates.

## Deploy

```bash
cd gateway
npm install
npx wrangler login                      # once per machine; the Vertex account is pinned in wrangler.toml
npx wrangler secret put CF_API_TOKEN    # API token with the "Workers AI - Read" permission on the Vertex account
npx wrangler secret put ADMIN_TOKEN     # any long random string; protects /admin/*
npm run deploy
```

Vars in `wrangler.toml`: `MONTHLY_LIMIT_USD=25`, `QUOTA_TIMEZONE=Europe/Istanbul`, `MODEL_ALLOWLIST=""`, `MODEL_ALIASES=""`, `MODEL_PRICES=""`.

- `MODEL_ALLOWLIST` — comma-separated model ids or prefixes, e.g. `@cf/meta/,@cf/openai/gpt-oss-120b`. Other models get `403 model_not_allowed` before any spend.
- `MODEL_ALIASES` — JSON map rewriting incoming model names, e.g. `{"llama":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"}`.
- `MODEL_PRICES` — JSON overrides in USD per million tokens, e.g. `{"@cf/meta/llama-3.3-70b-instruct-fp8-fast":{"input":0.293,"output":2.253}}`. Wins over the live catalog.

## Admin

Every `/admin` call needs `Authorization: Bearer <ADMIN_TOKEN>` (a Firebase ID token with the `admin: true` claim also works, so the admin panel can call these).

```bash
GW=https://gateway.<account>.workers.dev
TOKEN=...   # ADMIN_TOKEN

# Create a member (or rotate their key). The key is returned once and never stored in clear.
curl -X POST $GW/admin/members -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"email":"someone@vertexishere.com"}'
# -> { "email": "...", "apiKey": "vxg_...", "limitUsd": 25, "rotated": false }

# Custom limit for one person
curl -X POST $GW/admin/members -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"email":"lead@vertexishere.com","limitUsd":50}'

# Who spent what this month (add ?month=2026-08 for an earlier month)
curl $GW/admin/members -H "Authorization: Bearer $TOKEN"

# One member with full history
curl $GW/admin/members/someone%40vertexishere.com -H "Authorization: Bearer $TOKEN"

# Change limit / pause / resume
curl -X PATCH $GW/admin/members/someone%40vertexishere.com -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"limitUsd":30}'
curl -X PATCH $GW/admin/members/someone%40vertexishere.com -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"active":false}'

# Revoke
curl -X DELETE $GW/admin/members/someone%40vertexishere.com -H "Authorization: Bearer $TOKEN"

# Price catalog status; ?refresh=1 re-fetches it from Cloudflare
curl "$GW/admin/catalog?refresh=1" -H "Authorization: Bearer $TOKEN"
```

Rotations and revocations take effect immediately in the isolate that handled them and within 30 s everywhere else (member lookups are cached that long).

## Using a member key

The gateway speaks the OpenAI dialect; point any OpenAI-compatible client at it and use the `vxg_` key. Models are Workers AI ids (`@cf/...`); `GET /v1/models` lists the ones the gateway can serve, with their prices.

```bash
curl $GW/v1/chat/completions -H "Authorization: Bearer vxg_..." -H 'content-type: application/json' \
  -d '{"model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast","messages":[{"role":"user","content":"hi"}]}'

curl $GW/v1/embeddings -H "Authorization: Bearer vxg_..." -H 'content-type: application/json' \
  -d '{"model":"@cf/baai/bge-m3","input":"some text"}'

curl $GW/v1/models -H "Authorization: Bearer vxg_..."

# Budget check
curl $GW/v1/me -H "Authorization: Bearer vxg_..."
# -> { "month": "2026-09", "limitUsd": 25, "spentUsd": 3.21, "remainingUsd": 21.79, "resetsAt": "...", "byModel": {...} }
```

SDK settings:

| Tool | Setting |
|------|---------|
| OpenAI SDKs | `base_url = "$GW/v1"`, `api_key = "vxg_..."`, `model = "@cf/..."` |
| Cursor / Continue / any OpenAI-compatible client | base URL `$GW/v1`, key `vxg_...` |

Every proxied response carries `X-Gateway-Budget-Limit-Usd`, `X-Gateway-Budget-Spent-Usd` (spend before this request) and `X-Gateway-Budget-Resets-At`.

Proxied routes: `POST /v1/chat/completions`, `POST /v1/embeddings`; `GET /v1/models` (free). Streaming is passed through byte-for-byte; the token counts are read from the final SSE event.

## Notes

- Budget checks happen before forwarding; requests already in flight are not reserved. A burst of parallel calls can overshoot by roughly the cost of the calls that were in flight when the limit was crossed.
- If a response arrives without a usage block, tokens are estimated from character counts (3 characters per token, deliberately generous) and the request is flagged in `estimatedRequests` — it is never left unbilled.
- Prices are list prices; Workers AI's free daily allowance (10,000 neurons) is not subtracted, so the ledger can only over-count, never under-count.
- Upstream errors (4xx/5xx from Workers AI) are passed through unchanged and cost nothing.

## Tests

```bash
npm test                  # unit tests (pricing, usage parsing, quota math, key handling, upstream rewriting)
npm run test:integration  # boots `wrangler dev` against a fake Cloudflare API and exercises every route; no login needed
```
