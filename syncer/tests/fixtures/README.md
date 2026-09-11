# Provider Fixtures

Captured live provider payloads (trimmed but structurally intact) used by the
offline test suite. Regenerate with `node scripts/fetch-fixtures.mjs` (reads
`.dev.vars`; keys are never written into fixtures).

| File | Endpoint | Notes |
|---|---|---|
| `openrouter.json` | `GET https://openrouter.ai/api/v1/models` | Curated ids incl. `:free`, image-output, audio, file inputs. |
| `groq.json` | `GET https://api.groq.com/openai/v1/models` | Full first 25 (all models, incl. whisper / prompt-guard / compound). |
| `cloudflare.json` | `GET .../accounts/{id}/ai/models/search` | Array-shaped `properties` (incl. `context_window`, `price`, `reasoning`, `function_calling`). |
| `elevenlabs.json` | `GET https://api.elevenlabs.io/v1/models` | Full model objects with `languages[]` and `model_rates`. |
| `deepgram.json` | `GET https://api.deepgram.com/v1/models` | `stt[]` (nova + legacy) and `tts[]` (aura-2 voices). |
| `fal.json` | `GET https://api.fal.ai/v1/models` | First 6 pages, filtered to curated producers; real `metadata` shapes. |

The fixtures exist to pin the **normalizer contracts** (schema invariants, the
Cloudflare properties-array fix, Groq null-safe limits, ElevenLabs character
limits) against real payload shapes. They are not an exhaustive corpus.
