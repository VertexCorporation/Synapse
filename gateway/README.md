# Gateway

A metered proxy in front of OpenRouter for the **Array** department.

- **One upstream key.** The company OpenRouter key lives only in the worker (`OPENROUTER_KEY` secret). Members never see it.
- **One personal key per member.** Admins issue `vxg_...` keys; the worker maps each request to a member.
- **$25 per member per calendar month** (`MONTHLY_LIMIT_USD`, overridable per member). Spend is read from the `usage.cost` OpenRouter reports on every generation; when a response carries no cost (Anthropic-style bodies) the worker asks `/api/v1/generation` for it. Once a member's month-to-date spend reaches the limit, further requests get `402 budget_exhausted` until the 1st of the next month (`QUOTA_TIMEZONE`, default Europe/Istanbul).
- **Durable Objects, no KV.** `Registry` (one object) maps key hashes to members; `Ledger` (one object per member) keeps the month-by-month ledger. Per-member objects are single-threaded, so concurrent requests cannot lose updates.

## Deploy

```bash
cd gateway
npm install
wrangler login                      # once per machine
wrangler secret put OPENROUTER_KEY  # the company OpenRouter key
wrangler secret put ADMIN_TOKEN     # any long random string; protects /admin/*
npm run deploy
```

Defaults in `wrangler.toml`: `MONTHLY_LIMIT_USD=25`, `QUOTA_TIMEZONE=Europe/Istanbul`, `MODEL_ALLOWLIST=""` (any model), `MODEL_ALIASES=""`.

- `MODEL_ALLOWLIST` — comma-separated model ids or prefixes, e.g. `anthropic/,openai/gpt-4o`. Requests for other models get `403 model_not_allowed` before any spend.
- `MODEL_ALIASES` — JSON map rewriting incoming model names, e.g. `{"claude-sonnet-4-5":"anthropic/claude-sonnet-4.5"}`. Lets tools that send bare model names work through OpenRouter.

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
```

Rotations and revocations take effect immediately in the isolate that handled them and within 30 s everywhere else (member lookups are cached that long).

## Using a member key

The gateway speaks the OpenAI and Anthropic dialects; point any client at it and use the `vxg_` key.

```bash
# OpenAI-compatible
curl $GW/v1/chat/completions -H "Authorization: Bearer vxg_..." -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic-compatible (x-api-key is accepted too)
curl $GW/v1/messages -H "x-api-key: vxg_..." -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-4.5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# Budget check
curl $GW/v1/me -H "Authorization: Bearer vxg_..."
# -> { "month": "2026-09", "limitUsd": 25, "spentUsd": 3.21, "remainingUsd": 21.79, "resetsAt": "...", "byModel": {...} }
```

SDK settings:

| Tool | Setting |
|------|---------|
| OpenAI SDKs | `base_url = "$GW/v1"`, `api_key = "vxg_..."` |
| Anthropic SDKs / Claude Code | `ANTHROPIC_BASE_URL=$GW`, `ANTHROPIC_API_KEY=vxg_...` (add `MODEL_ALIASES` for bare Claude model names) |
| Cursor / Continue (OpenAI-compatible) | base URL `$GW/v1`, key `vxg_...` |

Every proxied response carries `X-Gateway-Budget-Limit-Usd`, `X-Gateway-Budget-Spent-Usd` (spend before this request) and `X-Gateway-Budget-Resets-At`.

Proxied routes: `POST /v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`; `GET /v1/models` (free). Streaming is passed through byte-for-byte; the cost is read from the final SSE event.

## Notes

- Budget checks happen before forwarding; requests already in flight are not reserved. A burst of parallel calls can overshoot by roughly the cost of the calls that were in flight when the limit was crossed.
- Requests whose cost cannot be determined (no `usage.cost` and no generation record) are counted in `unpricedRequests` and not charged. In practice OpenRouter reports cost on every generation.
- Upstream errors (4xx/5xx from OpenRouter) are passed through unchanged and cost nothing.

## Tests

```bash
npm test                  # unit tests (usage parsing, quota math, key handling, upstream rewriting)
npm run test:integration  # boots `wrangler dev` against a fake OpenRouter and exercises every route; no login needed
```
