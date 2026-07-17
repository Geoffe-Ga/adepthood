# Journal Photographer — Research Findings (R1–R5)

**Date:** 2026-07-16 · **Scope:** scoping-phase research for the Journal
Photographer feature (photograph handwritten pages → LLM transcription →
completed journal entry). All claims are grounded in the codebase with
`file:line` references. Where the scoping context contradicted the codebase,
the codebase wins and the discrepancy is flagged (§ Discrepancies).

---

## R1 — Journal entry lifecycle

### R1.1 Where the model is defined

**ORM:** `JournalEntry(SQLModel, table=True)` at
`backend/src/models/journal_entry.py:135`. Key fields:

| Field | Type / default | Notes |
|---|---|---|
| `timestamp` | `datetime`, `default_factory=datetime.now(UTC)` | `journal_entry.py:187-190`, `DateTime(timezone=True)`. **Server-set only** — no create-time input exists |
| `message` | `str`, required | `journal_entry.py:196`, encrypted at rest via `EncryptedString` |
| `title` | `str \| None` | `journal_entry.py:199`, max 200 chars |
| `status` | `str`, default `"draft"` | `journal_entry.py:200`; enum `EntryStatus` (`draft`/`finished`) at `journal_entry.py:59-66` |
| `classification` | default `"personal"` | `journal_entry.py:203`; `intimate` blocks resonance |
| `sender` | `'user'` or `'bot'`, server-set | `journal_entry.py:209` |
| `user_id` | FK, server-set | `journal_entry.py:210` |
| `deleted_at` | soft delete | `journal_entry.py:219-222` |
| `updated_at` | server-managed | `journal_entry.py:223-230` |

**Pydantic schemas:** `backend/src/schemas/journal.py` —
`JournalMessageCreate` (`journal.py:60-81`; `message` required 1–10,000
chars; **no `title`, `status`, or `timestamp` field**), `JournalEntryUpdate`
(PATCH, `journal.py:84-110`; can set `message`, `title`, `status`),
`JournalMessageResponse` (`journal.py:113-134`).

**Client types:** `frontend/src/api/index.ts` — `JournalMessageCreate`
(`index.ts:1130-1145`, no date field), `EntryStatus = 'draft' | 'finished'`
(`index.ts:1147`), `JournalMessage` (`index.ts:1149-1167`), Zod validator
`journalMessageSchema` (`frontend/src/api/schemas.ts:244-266`).

**What makes an entry "completed":** there is no separate completion concept
beyond `status`. An entry is born `draft`; a "completed" entry is one PATCHed
to `status: 'finished'`. There is **no single-call create-finished endpoint**
— the client's Finish path is create-then-PATCH (`finishWrite`,
`frontend/src/features/Journal/JournalEntryScreen.tsx:212-228`).

### R1.2 How an entry gets created today

- **`POST /journal/`** → `create_journal_entry`
  (`backend/src/routers/journal.py:146-176`): sanitizes the message
  (`journal.py:161`), forces `sender="user"` + `user_id` from the JWT
  (`journal.py:163`), returns 201.
- **`PATCH /journal/{entry_id}`** → `update_journal_entry`
  (`journal.py:352-390`), scoped to the caller's own non-deleted rows.
- **Client state is local React state + refs, not Zustand.** The write path
  is `JournalEntryScreen.tsx`: `createEntry` (`JournalEntryScreen.tsx:156-169`)
  calls `journal.create(...)`; `writeEntry` (`:177-201`) creates on first
  save, PATCHes thereafter. The autosave engine is a hook stack —
  `useJournalAutosave` (`:908`) → `useDebouncedSave` (`:705`) →
  `useSaveRunner` / `useFinishWriter` / `useSaveTimer` — with a single-flight
  guard (`inFlightRef`, `:480`) preventing double-create.

### R1.3 What makes the autosave indicator show "saved"

The indicator is a **pure client state machine** in
`JournalEntryScreen.tsx`: `SaveState = 'idle' | 'typing' | 'saving' | 'saved'
| 'error'` (`:91`), rendered via `savedHintLabel` (`:98-103`) at
`:1122-1124` (`testID="journal-save-hint"`). Debounce is
`AUTOSAVE_DELAY_MS = 1500` (`:63`). The transition to `'saved'` happens when
the network write's promise resolves: `trackedWrite` (`:426-450`) sets
`setSaveState('saved')` at `:438`; the atomic Finish path sets it at
`:558-559`. **No server field drives it** — the only server dependency is a
successful 201/200.

**Minimal correct path for a programmatically created entry:** route the
create through the same machinery (or call `setSaveState('saved')` after a
successful `journal.create` + finish PATCH). If the new flow saves via the
existing `finish()`/`finishWrite` path (`:212-228`), it gets both
`status: 'finished'` persistence *and* the `'saved'` hint for free.

### R1.4 "Get Resonance" enablement conditions

Component `frontend/src/features/Journal/GetResonanceButton.tsx`, wired at
`JournalEntryScreen.tsx:1965-1970`.

- **Visible** when `isLoading || (isIdle && hasContent)`
  (`GetResonanceButton.tsx:18-26`).
- **`hasContent`** = `body.trim().length > 0` (`JournalEntryScreen.tsx:1535`)
  — no minimum length.
- **`isIdle`** from `useIdle()` (`:1651`) — user paused typing.
- **Disabled** when `classification === 'intimate'` (`deriveResonanceGate`,
  `:1534-1549`); hidden in weekly-prompt compose mode (`:1539-1540`).
- **Not gated on**: entry `status`, wallet balance (server enforces via 402),
  or prior resonance runs.
- Calls `resonance.generate(entryId)` → `POST /journal/{entry_id}/resonance`
  (`index.ts:1432-1439`; backend `journal.py:716-779`), which flushes the
  draft first and requires a non-null entry id (`useResonance.ts:197-202`).
  Wallet pre-deducts one unit (`journal.py:755`), rolled back on provider
  failure (`journal.py:511`).

**Implication for the feature:** an entry created by the capture flow that is
saved (id exists), non-empty, and not `intimate` satisfies every condition —
nothing extra is needed to make "Get Resonance" tappable.

### R1.5 Entry dates — storage, display, backdating

- Stored as a UTC **datetime** (`timestamp`, `journal_entry.py:187-190`),
  server-set. **The API has no backdating path today**: neither
  `JournalMessageCreate` (`schemas/journal.py:60-81`) nor the TS type
  (`index.ts:1130-1145`) carries a date, and `create_journal_entry` never
  reads one. Precedent for backdating exists in habits: goal completions
  accept `completed_on: YYYY-MM-DD` (`index.ts:1031-1039`).
- Display: `formatDate(timestamp)` (`frontend/src/features/Journal/recency.ts:23-27`);
  shelf buckets by age via `groupByRecency` (`recency.ts:8-45`).
- **A reusable date picker already exists**:
  `frontend/src/components/DatePicker.tsx` (wraps
  `react-native-modal-datetime-picker`; props include `value`, `onChange`,
  `minDate`, `maxDate` at `DatePicker.tsx:14-21`; `toISODate`/`parseISODate`
  helpers at `:23-38`; tested; used by Habits onboarding and
  `ReorderHabitsModal`). Directly reusable for the capture flow's date field.

### R1.6 Ordering hazard a backdated entry will surface

Server list order is **`id DESC`** (`journal.py:269`), while client bucketing
is by **`timestamp`** (`recency.ts:40-45`) with no intra-bucket re-sort. A
backdated entry gets the highest `id` but an old `timestamp`, so it files
into an older bucket yet sorts *first* within it — visibly out of
chronological order. Backdating work must either switch the server
`order_by` to `timestamp DESC` (+ index) or sort within buckets client-side.

---

## R2 — LLM infrastructure

### R2.1 Call path end to end

**All LLM calls are server-side.** The client never talks to a provider; it
may only supply a BYOK key via the `X-LLM-API-Key` header
(`frontend/src/api/index.ts:189`, forwarded at `index.ts:1430-1454`).

The provider abstraction is a declarative registry in
`backend/src/services/botmason.py`:

- `PROVIDER_REGISTRY: dict[str, ProviderSpec]` (`botmason.py:112-136`) —
  `openai` (default model `gpt-4o-mini`; allowlist `gpt-4o-mini`, `gpt-4o`,
  `gpt-4-turbo`) and `anthropic` (default `claude-sonnet-4-20250514`;
  allowlist adds `claude-haiku-4-5-20251001`, `claude-opus-4-7`,
  `claude-sonnet-4-6`).
- Entrypoint `generate_response(...)` (`botmason.py:605-653`) → dispatches to
  `_call_openai` (`botmason.py:720-750`, `openai.AsyncOpenAI`) or
  `_call_anthropic` (`botmason.py:753-792`, `anthropic.AsyncAnthropic`).
- Default provider is **`stub`** (`_stub_response`, `botmason.py:656-673`) —
  canned, zero-token dev/test path.
- Domain seam: Protocol `ResonanceLLM.complete(prompt: str) -> str`
  (`backend/src/domain/resonance.py:71-74`); adapter `BotmasonResonanceLLM`
  (`backend/src/services/marginalia.py:30-48`), which also accumulates
  per-call usage for metering.

**Current call sites (all in `routers/journal.py`):** resonance margin notes
(`journal.py:757-758`, the only wallet-charged call), completion detection
(`journal.py:477-496`, best-effort), and essay expansion
(`journal.py:1079-1089`). `weekly_prompts.py` and `practice_insights.py` do
**not** call the LLM.

### R2.2 Global model settings

**Env-vars only; no settings table, no runtime/admin control**
(`backend/.env.example:19-33`): `BOTMASON_PROVIDER` (default `stub`,
`botmason.py:204-206`), `LLM_MODEL` (validated against the allowlist,
fail-fast `LLMProviderError` at `botmason.py:520-527`), `LLM_API_KEY`
(`botmason.py:681`), `BOTMASON_SYSTEM_PROMPT` (`botmason.py:338`). BYOK
selects the *provider* by key prefix (`botmason.py:291-323`) but the *model*
still comes from server config. Changing the model = redeploy. Every
allowlisted model must have a pricing row in
`backend/src/services/llm_pricing.py:70-82` (unknown models log
`llm_pricing_unknown_model` and record `None` cost, `llm_pricing.py:99-111`).

### R2.3 Multimodal / vision support

**Not supported today — messages are plain `{"role": str, "content": str}`
dicts.** Builders: `_build_messages` (`botmason.py:480-497`),
`_build_anthropic_messages` (`botmason.py:530-546`), `_wrap_history`
(`botmason.py:457-477`). The domain seam is `complete(prompt: str) -> str`.

**Minimal extension:** both SDKs accept structured content blocks in place
of a string. Widen content to `str | list[dict]` in the three builders so a
user turn can carry `[{"type":"text",...}, {"type":"image","source":
{"type":"base64","media_type":...,"data":...}}]` (Anthropic) or the
`image_url` part (OpenAI); add an image-capable sibling to the
`ResonanceLLM` seam. Note the nonce-wrapping/sanitization in
`_wrap_user_input` (`botmason.py:422-440`) applies to text parts only —
image parts must bypass it.

**Vision capability of currently allowlisted models:** every *real*
allowlisted model (gpt-4o-mini, gpt-4o, gpt-4-turbo, claude-sonnet-4,
claude-haiku-4-5, claude-opus-4-7, claude-sonnet-4-6) supports image input.
The gap is (a) the default `stub` provider, which needs a stub transcription
path for dev/test, and (b) future allowlist additions — hence ADR-3's
fallback policy.

### R2.4 Where prompt text lives

Prompts are **inline Python builder functions in `backend/src/domain/*`**
(the `backend/src/prompts/` dir is only for operator-supplied system-prompt
files; loader `get_system_prompt` at `botmason.py:326-362`). Existing
builders the transcription prompt must mirror:

- `build_prompt` (resonance) — `domain/resonance.py:77-110`
- `_build_essay_prompt` — `domain/resonance.py:213-230`
- `build_detection_prompt` — `domain/detection.py:67-93`

Shared conventions: lead with `MEDICATION_GUARDRAIL` from `domain.care`
(`resonance.py:96`); state a role; demand STRICT JSON with an explicit shape
example (`resonance.py:107-108`); wrap user content in XML-ish delimiters
(`<entry>…</entry>`); pair with a defensive parser that never raises
(`_parse_drafts`, `resonance.py:133-139`). The transcription prompt should be
a `build_transcription_prompt()` in a new `domain/transcription.py` following
this exact shape.

### R2.5 Retry, timeout, error handling

- Timeout: `_LLM_TIMEOUT_SECONDS = 30.0` (`botmason.py:139`), passed to both
  SDK constructors (`botmason.py:731`, `:763`).
- Retry: hand-rolled `_retry_on_transient` (`botmason.py:575-602`);
  `_MAX_RETRIES = 2`, base delay 1s doubling, retryable statuses
  `{429,500,502,503,504}` (`botmason.py:142-144`).
- Single normalized exception `LLMProviderError` (`botmason.py:157-168`);
  provider SDK errors mapped at `botmason.py:174-179, 651-652`.
- Surfacing: charged resonance failure → **502 `llm_provider_error`** with
  wallet rollback (`journal.py:508-512`); missing key → **402
  `llm_key_required`** (`botmason.py:272-273`); malformed BYOK → **400**
  (`botmason.py:257`). The transcription endpoint should reuse all of this
  unchanged.
- Rate limits (slowapi): resonance and essay are `10/minute`
  (`journal.py:717`, `:1040`).

### R2.6 LLM usage log (privacy-relevant)

`LLMUsageLog` (`backend/src/models/llm_usage_log.py:36-72`) persists **token
counts and metadata only**: `user_id`, `timestamp`, `provider`, `model`,
`prompt_tokens`, `completion_tokens`, `total_tokens`, `estimated_cost_usd`,
`journal_entry_id`. The single write site `record_llm_usage`
(`backend/src/services/llm_usage.py:26-57`) reads only numeric fields from
`LLMResponse` — never `.text`, never the prompt. **An image payload cannot
reach this table under current code.** The requirement "text-only logging for
this path" is already satisfied structurally; the constraint is that no
content column is ever added (the table is append-only,
`llm_usage_log.py:3-8`).

### R2.7 Wallet / credits

Resonance charges exactly one unit via `preflight_deduction`
(`backend/src/services/wallet.py:297`, called at `journal.py:755`) against
free-monthly (`BOTMASON_MONTHLY_CAP`, `services/usage.py:41`) then
`offering_balance` (`models/user.py:54-55`), with rollback on provider error
and an append-only `WalletAudit` trail (`models/wallet_audit.py:71-142`).
**Open product question (flagged, not decided here):** whether transcription
should charge wallet units — a 10-page session costs roughly 10× a resonance
call at the default model (see R5).

---

## R3 — Image capture and transport

### R3.1 Existing camera/picker capability

- **`expo-image-picker ~16.0.6` is already a dependency** (Expo SDK ~52,
  RN 0.76.9, new architecture enabled — `frontend/app.json:14`).
- One production call site, **media-library only, no camera**:
  `frontend/src/features/Practice/utils/pickCardPhoto.ts:24-31`
  (`requestMediaLibraryPermissionsAsync()` then
  `launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 })`).
  Its doc explicitly says the returned `uri` is a device path stored as-is —
  **nothing in the app uploads image bytes today**.
- No `launchCameraAsync`, no `expo-camera`, no other image libs. Jest mock
  exists at `frontend/src/__mocks__/expo-image-picker.js`.

### R3.2 Permissions

- Config is `frontend/app.json`. The only plugin is `expo-image-picker` with
  `photosPermission` set (`app.json:16-23`) — the plugin injects
  `NSPhotoLibraryUsageDescription` at prebuild. **No `cameraPermission` is
  configured**, so camera capture requires adding it (plugin option injects
  `NSCameraUsageDescription`; Android `CAMERA` permission likewise via
  plugin defaults).
- Runtime patterns: inline per-feature calls — `pickCardPhoto.ts:24-27`
  (silent no-op on denial) and
  `features/Habits/hooks/useHabitNotifications.ts:26-48` (get-then-request
  with retry). **No shared permission abstraction exists**; the capture flow
  should follow the inline pattern (and must improve on silent denial with a
  user-facing recovery path, per the failure-path requirement).

### R3.3 Request-size ceiling

- **No app-level body limit anywhere.** `backend/src/main.py` middleware
  stack (`main.py:422-436`) has no size cap; Starlette/FastAPI impose no
  default total-body limit; uvicorn is launched with no size flags
  (`backend/Dockerfile:71`). Deployment is Railway (`backend/railway.toml`)
  — the effective ceiling is the Railway edge proxy, which is not defined in
  the repo. `frontend/nginx.conf` serves the SPA only and does not proxy the
  API.
- **No file-upload endpoint exists** — zero `UploadFile`/`File()`/multipart
  in `backend/src`; all routers are JSON-only. `python-multipart` is not a
  dependency.
- **Consequence:** the transcription endpoint must define the app's first
  explicit payload policy (per-image and per-request caps validated
  server-side) rather than inheriting one.
- **Downscaling requirement:** Anthropic resizes images above ~1568px long
  edge / ~1.15 MP server-side (≈1,600 tokens max per image), and the API
  caps ~5 MB per image. Sending more than ~1568–2000px long edge wastes
  payload with zero OCR benefit. Handwriting legibility guidance (long edge
  ~1500–2000px) fits inside that. Client-side downscale/compress requires
  **`expo-image-manipulator` — a new dependency** (`expo-file-system` may
  also be needed to read bytes/base64; neither is installed today —
  confirmed absent from `frontend/package.json`). `expo-image-picker` can
  return base64 directly (`base64: true` option) at pick time, which may
  avoid `expo-file-system` for the tracer.

### R3.4 Frontend HTTP client

`frontend/src/api/index.ts`: native `fetch`, central `request<T>()`
(`index.ts:735-776`), base URL from `EXPO_PUBLIC_API_BASE_URL`
(`config.ts:36`), Bearer auth injection (`index.ts:281-294`), hard-coded
`Content-Type: application/json` (`index.ts:290-292`) — **no
FormData/multipart path exists**. Timeout `FETCH_TIMEOUT_MS = 30_000` with
per-request override (`index.ts:81, 271-272`); retries only idempotent
methods / idempotency-keyed requests on transient statuses
(`index.ts:84-94, 319-340`); offline fast-fail wired to
`NetworkStatusContext` (`index.ts:139-145, 762-764`). Sending images as
**base64 fields in JSON** fits this client with zero transport changes;
multipart would require a new branch.

### R3.5 Multi-page transport inputs (feeds ADR-2)

- Per-page payload at 1568px long edge, JPEG q≈0.8: ~300–600 KB → ~400–800 KB
  base64. Ten pages in one request ≈ 4–8 MB JSON.
- Provider ceilings: Anthropic ≤100 images/request, ~5 MB each; OpenAI
  ≤20 MB each — neither binds at realistic page counts.
- The binding constraints are the **30s server-side LLM timeout**
  (`botmason.py:139`) and the **30s client fetch timeout** (`index.ts:81`):
  one LLM call transcribing N pages scales latency ~linearly with N and
  bursts both budgets around 3–5 pages. Per-page calls each fit comfortably.
- Partial failure: the client retry layer only retries idempotent/keyed
  requests — per-page requests give natural per-page retry.

### R3.6 Reorderable thumbnails

`react-native-draggable-flatlist ^4.0.2` (+ gesture-handler, reanimated) is
installed and used. Cleanest template:
`frontend/src/features/Habits/components/ReorderHabitsModal.tsx:124-136`
(`DraggableFlatList` with `onDragEnd`, `onLongPress={drag}`, `isActive`
styling at `:42-63`). Copy this pattern for page thumbnails.

---

## R4 — Privacy and the no-persistence guarantee

**Baseline: the current codebase is clean.** No image ever enters the
backend today, and every existing logging/persistence surface is
content-free. The guarantee is enforced going forward by avoiding the nine
seams below.

| # | Seam | Current state | Constraint for this feature |
|---|---|---|---|
| 1 | Request logging middleware | Logs method/path/status/ms only (`backend/src/middleware/logging.py:78-87`); no body reads; no uvicorn access-log config (`observability.py:194-207`) | Never put image data in a path/query param |
| 2 | App logging | All `logger.*` calls are metadata-only (e.g. `journal.py:175`); injection detector logs a fact, not content (`botmason.py:373`) | No new log line may interpolate prompt/image/transcript; copy the log-the-fact pattern |
| 3 | `LLMUsageLog` | Token counts + ids only (`llm_usage_log.py:36-72`; write site `llm_usage.py:44-57`) | Never add a content column (table is append-only) |
| 4 | Temp files / disk | No `UploadFile`, no tempfile, no object-storage clients anywhere in `backend/src` | **If `UploadFile`/multipart were used, Starlette spools >~1 MB bodies to a real disk temp file** — photos would transiently hit disk. Accept bounded base64 JSON and keep bytes in memory instead |
| 5 | Backend Sentry | No-op stub with a closed `SentryContext` TypedDict (`backend/src/sentry.py:30-61`) — no body/breadcrumb capture possible | When a real DSN lands: `send_default_pii=False` + `before_send` scrubber; keep the allow-list closed |
| 6 | Frontend Sentry | `console.error` shim with closed `ReportContexts` (`frontend/src/observability/sentry.ts:33-51`) | Keep the union closed; no image/body field |
| 7 | Client caches | **`expo-image-picker` copies picked/captured images into the app cache dir and nothing in the repo ever cleans it** (no `expo-file-system` usage anywhere) | Capture-flow images must be deleted from cache after transcription (needs `expo-file-system`), or the "transient" claim is false on-device |
| 8 | Provider retention | LLM calls pass only `model`/`messages`/`max_tokens`(/`system`) — no `metadata`, no user field (`botmason.py:735-740`, `:774-780`) | Keep it that way; provider-side retention is governed by account settings — document this as an accepted boundary, and pass no user-identifying metadata on image calls |
| 9 | DB columns | No binary/base64 content columns in any model (only bounded URI *strings* in practice config, `schemas/practice_mode_config.py:365-378`) | Never add a `LargeBinary`/base64-text column for images |

**Answer to R4's second question:** the transcription request/response
cannot land in the LLM audit log with the image payload included — the log
never stores content (seam 3). The requirement is met by construction and
must be protected by a regression test asserting `LLMUsageLog` has no
text/blob columns and that the transcription code path emits no
content-bearing log records.

---

## R5 — Cost and limits

Grounded in the repo's own pricing table
(`backend/src/services/llm_pricing.py:70-82`) and Anthropic/OpenAI vision
token accounting (image tokens ≈ pixels/750 for Anthropic, capped ≈1,600 at
the 1.15 MP downscale limit).

**Per-page token model** (page downscaled to ~1568px long edge):
~1,400–1,600 image tokens + ~600–900 prompt tokens (role, conventions,
few-shot examples) input; ~300–500 output tokens for a full handwritten page
(~200–350 words).

| Model (repo pricing) | $/MTok in/out | Est. cost per page | 10-page session |
|---|---|---|---|
| `claude-haiku-4-5-20251001` | 1.00 / 5.00 | ≈ $0.005 | ≈ $0.05 |
| `claude-sonnet-4-20250514` (**Anthropic default**) | 3.00 / 15.00 | ≈ $0.014 | ≈ $0.14 |
| `claude-sonnet-4-6` | 3.00 / 15.00 | ≈ $0.014 | ≈ $0.14 |
| `claude-opus-4-7` | 15.00 / 75.00 | ≈ $0.07 | ≈ $0.70 |
| `gpt-4o` | 2.50 / 10.00 | ≈ $0.009 | ≈ $0.09 |
| `gpt-4o-mini` (**OpenAI default**) | 0.15 / 0.60 | ≈ $0.004–0.006 (image tokens are multiplied ~33× on mini, so images cost near gpt-4o rates) | ≈ $0.05 |

Notes:

- Estimates use the mid-range token model; ±50% is realistic depending on
  page density and prompt length. The transcription prompt is reused
  verbatim per page, so Anthropic prompt caching could shave input cost
  later — not required for scoping.
- **Comparison anchor:** one resonance call is roughly the same order as one
  transcribed page on the default model, but the wallet charges resonance
  1 unit while transcription is (so far) unpriced. A 10-page session ≈ 10
  resonance calls of provider cost.

**Arguments for a page cap, and the proposal:**

1. Cost: unbounded pages × ~$0.014 on the default model, with no wallet
   gating decided yet.
2. Latency: per-page LLM latency is roughly 5–15 s; sessions beyond ~10
   pages exceed a minute of total work even with concurrency.
3. Payload: 10 pages ≈ 4–8 MB base64 total across requests — comfortable;
   50 pages is not.
4. Abuse surface: the endpoint accepts attacker-supplied binary blobs; a cap
   bounds the blast radius alongside per-image size validation.

**Proposal: cap at 10 pages per capture session** (constant, e.g.
`MAX_PAGES_PER_SESSION = 10`), enforced in the capture UI (add-photo
disabled at cap with a friendly message) **and** server-side (per-request
image-count/size validation → 422). Rate-limit the transcription endpoint at
`10/minute` to match resonance/essay (`journal.py:717`, `:1040`). Revisit
the cap with real usage data; it is a named constant, not a magic number.

---

## Discrepancies: scoping context vs codebase

1. **"Global model-selection settings"** exist but are deploy-time env vars
   only (`BOTMASON_PROVIDER`/`LLM_MODEL`) — no settings table, no admin UI,
   plus per-user BYOK provider selection. "Defaulting to globally configured
   model settings" therefore means: reuse `generate_response(...)`'s existing
   resolution (`botmason.py:311-323`, `:516`) unchanged.
2. **The out-of-box provider is `stub`**, not a real LLM. The transcription
   path needs a stub behavior for dev/test parity (canned transcription),
   mirroring `_stub_response` (`botmason.py:656-673`).
3. **"Autosave mechanism"** is a client-side debounced state machine, not a
   server concept — the "saved" indicator is set on promise resolve
   (`JournalEntryScreen.tsx:438`). "Autosave explicitly flagged as
   successful" is achieved by reusing that machinery, not by any API field.
4. **Entry dates cannot currently be set by the client** — backdating is a
   net-new backend capability (schema + endpoint + ordering fix), not a
   reuse of existing behavior (§ R1.5–R1.6).
5. **"Entries indistinguishable from typed ones"** requires the
   create-then-PATCH-finished dance (or a deliberate finished-on-create
   extension) — there is no single-call completed-entry creation today.
