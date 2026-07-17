# Journal Photographer — Implementation Plan

> **Filed on GitHub (2026-07-17):** epic
> [#1799](https://github.com/Geoffe-Ga/adepthood/issues/1799) with 13
> sub-issues. Plan-issue mapping: 01→#1786, 02→#1787, 03→#1789, 04→#1790,
> 05→#1791, 06→#1788, 07→#1792, 08→#1793, 09→#1794, 10→#1795, 11→#1796,
> 12→#1798, plus #1797 (classification + intimate transcription gate, added
> when the open questions were decided). Decisions adopted on the open
> questions: wallet charges 1 unit per transcribed page (resonance pattern);
> `intimate` blocks transcription with a typed-entry offramp (per the
> ratified INTIMATE-never-cloud model, #893/#927); provider-side retention
> is an accepted, documented boundary. The GitHub issues are the source of
> truth from here.

**Date:** 2026-07-16 · **Style:** tracer-code (demoable skeleton first,
then flesh) · **Inputs:** research findings
(`2026-07-16_journal_photographer_research_findings.md`) and ADRs 1–4
(server-side call · per-page transport · explicit vision-fallback error ·
progressive delivery). Implementation starts only after plan approval; each
issue below ships via the stay-green TDD workflow (Gate 1 red-green-refactor,
Gate 2 pre-commit, conventional commits, one logical change per PR).

## Guiding decisions (from ADRs — assumed approved)

1. Vision call: client → FastAPI → provider (ADR-1).
2. Transport: one request per page, client merges, concurrency 2, 10-page
   session cap, endpoint rate limit `20/minute` (ADR-2).
3. Vision-incapable model: 422 `model_lacks_vision` with guidance; `stub`
   provider returns a canned transcription (ADR-3).
4. Delivery UX: progressive per-page blocks in an editable preview; Save
   gated on all pages resolved; late results never overwrite edits (ADR-4).

## Invariants every phase must preserve

- **No image persistence:** bounded base64 JSON only (no
  `UploadFile`/multipart, which spools >1 MB bodies to disk); in-memory
  handling; no content-bearing log lines; `LLMUsageLog` stays
  token-counts-only; picker cache deleted after transcription (research § R4).
- **Typed journal entries unchanged:** the capture flow converges on the
  existing `POST /journal/` + PATCH-finish path and the existing autosave
  state machine — no behavior change for typed entries.
- **Existing LLM conventions:** provider registry, 30 s timeout, retry
  wrapper, `LLMProviderError` → 502, BYOK header, prompt-builder style in
  `backend/src/domain/`, usage logging.

---

## Phase 1 — Tracer bullet: one photo → entry (demoable)

End state: on a dev build with the `stub` provider, a user picks **one**
photo from the library, sees a canned transcription in an editable preview,
taps Save, and lands on a finished journal entry dated today with the saved
hint showing and "Get Resonance" tappable. Every layer of the real
architecture is exercised end to end; nothing is throwaway.

| # | Issue | Scope | Est. LoC |
|---|---|---|---|
| 01 | Vision content blocks + capability flag in the LLM layer | Backend | ~250 |
| 02 | Transcription prompt builder (`domain/transcription.py`) | Backend | ~150 |
| 03 | `POST /journal/transcribe-page` endpoint | Backend | ~250 |
| 04 | Client API: `journal.transcribePage` + types | Frontend | ~120 |
| 05 | Tracer capture flow (pick → transcribe → preview → save) | Frontend | ~300 |

### Issue 01 — feat(backend): vision content blocks + capability flag in the LLM layer

- Widen message content from `str` to `str | list[ContentPart]` through
  `_wrap_history` / `_build_messages` / `_build_anthropic_messages`
  (`services/botmason.py:457-546`); image parts bypass `_wrap_user_input`
  sanitization (text parts unchanged).
- Add per-provider vision-capability metadata to `PROVIDER_REGISTRY`
  (`botmason.py:112-136`) + a `supports_vision(provider, model)` helper;
  extend `generate_response(...)` (or add a sibling `generate_vision_response`)
  accepting `images: list[ImagePayload]` (base64 + media type).
- `stub` provider: deterministic canned transcription when images are
  present (mirrors `_stub_response`, `botmason.py:656-673`).
- Tests: content-block construction per provider, sanitizer bypass for image
  parts, capability helper truth table, stub image path, retry/timeout
  behavior unchanged.

### Issue 02 — feat(backend): transcription prompt builder

- New `backend/src/domain/transcription.py` with
  `build_transcription_prompt()` following the house convention
  (`domain/resonance.py:77-110`): `MEDICATION_GUARDRAIL` lead, role
  statement, output = journal body text only (no preamble/commentary/
  markdown headers).
- Encodes the settled prompt-engineering spec: faithful transcription (no
  summarizing/rewriting; preserve spelling quirks and paragraph breaks);
  omit struck-through text; `[illegible]` for unreadable, `[word?]` for
  best-guess; margin notes integrated at arrows/carets else appended to the
  nearest paragraph; includes the 2–3 few-shot instruction examples from the
  scoping doc (cross-out, `[illegible]`, caret-insertion).
- Tests: prompt contains each convention token/example; deterministic output;
  golden snapshot.

### Issue 03 — feat(backend): `POST /journal/transcribe-page` endpoint

- Request: `{ image_base64: str, media_type: 'image/jpeg' | 'image/png' | 'image/webp' }`;
  response: `{ text: str }`. **Stateless** — nothing written to the DB; the
  entry is created later by the existing journal endpoints.
- Server-side validation (security skill: images are untrusted input):
  base64 decodes; decoded size ≤ `MAX_IMAGE_BYTES` (5 MB, matching the
  Anthropic per-image cap) → 422; magic-bytes check matches declared media
  type → 422; auth via `get_current_user`; slowapi
  `TRANSCRIBE_RATE_LIMIT = "20/minute"` (ADR-2).
- Calls issue-01's vision path with issue-02's prompt; maps
  `LLMProviderError` → 502 `llm_provider_error` (reuse
  `routers/journal.py:508-512` pattern); vision-incapable model → 422
  `model_lacks_vision` (ADR-3); BYOK header honored via
  `resolve_chat_api_key`.
- Records `LLMUsageLog` row (token counts only, `journal_entry_id=None`).
- Tests: happy path (stub), each 422, 401, 429, 502 + no-retry-on-4xx,
  usage-log row shape, **regression test asserting no content-bearing log
  records are emitted by this path**.

### Issue 04 — feat(frontend): transcription API client

- `journal.transcribePage({ imageBase64, mediaType })` in
  `frontend/src/api/index.ts` with Zod response schema
  (`frontend/src/api/schemas.ts`), BYOK header parity with resonance
  (`index.ts:1420-1423`), and a per-request `timeoutMs` of 60 s (vision
  latency headroom; the default 30 s is tight at p95).
- Error mapping for `model_lacks_vision`, size/type 422s, 429, 502 into
  typed results the UI can branch on.
- Tests: request shape, header injection, error taxonomy.

### Issue 05 — feat(frontend): tracer capture flow

- "Photograph journal" affordance on the Journal shelf alongside the
  existing new-entry action → minimal capture screen: pick one image
  (`launchImageLibraryAsync` with `base64: true`, `quality: 0.8` — the
  `pickCardPhoto.ts:24-31` pattern, plus a visible denial recovery state) →
  transcribe (single-block progressive preview per ADR-4) → editable text →
  Save.
- Save = existing `journal.create` + finish PATCH (the `finishWrite` dance,
  `JournalEntryScreen.tsx:212-228`), then navigate into the entry with the
  save-hint machinery landing on `'saved'` — which makes "Get Resonance"
  enabled by construction (research § R1.4).
- Failure paths (tracer level): transcription error → Retry / Pick another /
  Cancel; save failure → edited text stays in the preview (no silent loss).
- Tests (RTL): affordance renders, permission-denied state, happy path with
  mocked picker + API, edited-text-survives-save-failure, resonance button
  enabled on the resulting entry screen.

**Phase 1 exit demo:** stub-provider end-to-end on simulator; real-provider
smoke test behind `BOTMASON_PROVIDER=anthropic` in a dev environment.

---

## Phase 2 — Entry date: pick the day it was written

| # | Issue | Scope | Est. LoC |
|---|---|---|---|
| 06 | Backdated entry creation + list-ordering fix | Backend | ~200 |
| 07 | Date picker in the capture flow | Frontend | ~120 |

### Issue 06 — feat(backend): backdated entry creation

- Add optional `entry_date: date | None` to `JournalMessageCreate`
  (`schemas/journal.py:60-81`) — a calendar date, not a datetime, matching
  how users think about "the day I wrote this" (precedent: goal completions'
  `completed_on`, `index.ts:1031-1039`). Server maps it to a UTC timestamp
  (noon UTC on that date, or day-start; decided in the issue with tests);
  rejects future dates → 422; absent → today (current behavior, so **typed
  entries are unaffected**).
- Fix the ordering hazard (research § R1.6): change the list query to
  `ORDER BY timestamp DESC, id DESC` (`routers/journal.py:269` and the
  encrypted-search path `journal.py:223`) + Alembic migration for a
  composite index. Verify shelf bucketing (`recency.ts`) renders backdated
  entries in chronological position.
- Tests: create with/without date, future-date rejection, ordering with
  interleaved backdated entries, migration up/down.

### Issue 07 — feat(frontend): date picker in the capture flow

- Reuse `frontend/src/components/DatePicker.tsx` (`DatePicker.tsx:14-21`)
  in the capture session, default today, `maxDate` today; chosen date passed
  as `entry_date` on save; shelf shows the backdated position correctly.
- Tests: default value, max-date enforcement, date threaded into the create
  call.

---

## Phase 3 — Multi-page sessions

| # | Issue | Scope | Est. LoC |
|---|---|---|---|
| 08 | Multi-page capture session UI (thumbnails, reorder, remove) | Frontend | ~300 |
| 09 | Progressive per-page transcription, merge, per-page recovery | Frontend | ~350 |

### Issue 08 — feat(frontend): multi-page capture session

- Session model: ordered list of pages (uri, base64, status); add-from-
  library multi-select; thumbnails with remove; drag-reorder via
  `DraggableFlatList` copying `ReorderHabitsModal.tsx:124-136`; add
  disabled at `MAX_PAGES_PER_SESSION = 10` with friendly copy.
- Tests: add/remove/reorder state, cap enforcement, order preserved into the
  transcribe step.

### Issue 09 — feat(frontend): progressive transcription + merge

- Scheduler: per-page `transcribePage` calls, concurrency 2, results keyed
  by page index (ADR-2); preview renders one block per page filling in as
  results land (ADR-4); per-page inline error card with Retry / Retake /
  Remove; a resolved transcription fills a block only if the user hasn't
  edited it; Save disabled until every remaining page is resolved.
- Merge: blocks joined in capture order with a blank line between pages, no
  page markers (settled requirement); merged text flows into the Phase-1
  save path (+ Phase-2 date).
- Tests: ordering under out-of-order completion, concurrency bound, retry
  replaces only its block, edited block never overwritten, save gate,
  merge format.

---

## Phase 4 — Camera capture and image pipeline

| # | Issue | Scope | Est. LoC |
|---|---|---|---|
| 10 | Camera capture + permissions config | Frontend | ~150 |
| 11 | Client-side downscale/compress + cache cleanup | Frontend | ~200 |

### Issue 10 — feat(frontend): camera capture

- Add `cameraPermission` to the `expo-image-picker` plugin config
  (`app.json:16-23`) — injects `NSCameraUsageDescription` / Android
  permission at prebuild; capture-session "Take photo" action via
  `launchCameraAsync`; denial → recovery state linking to Settings (improve
  on the silent no-op in `pickCardPhoto.ts:24-27`).
- Tests: permission flows (mocked), captured page enters the session like a
  picked one.

### Issue 11 — feat(frontend): downscale/compress + cache cleanup

- Add `expo-image-manipulator` (+ `expo-file-system` for cache deletion) —
  **new dependencies**; both are first-party Expo modules already covered by
  the ADR-1/R4 analysis (downscaling is required: >1568 px long edge is
  wasted payload; cache deletion is required for the no-persistence
  guarantee). Resize to `TRANSCRIBE_LONG_EDGE_PX = 1568`, JPEG
  `TRANSCRIBE_JPEG_QUALITY = 0.8`, before base64.
- Delete picker/camera cache files (and manipulator outputs) as soon as the
  page's transcription resolves or the session is discarded — the images-
  are-transient guarantee on device (research § R4 seam 7).
- Tests: resize invoked for oversized images, cleanup called on success /
  failure / cancel, payload under `MAX_IMAGE_BYTES` post-processing.

---

## Phase 5 — Hardening and privacy proof

| # | Issue | Scope | Est. LoC |
|---|---|---|---|
| 12 | Privacy regression suite + payload/limit audit | Backend | ~150 |

### Issue 12 — test(backend): privacy regression suite

- Assertions that hold the R4 guarantees permanently: `LLMUsageLog` schema
  contains no text/blob columns; transcription request/response paths emit
  no log records containing base64/body content (caplog scan); no
  `UploadFile`/multipart imports in `routers/`; endpoint rejects oversized
  and mistyped payloads; rate limit active.
- Docs: `.env.example` note on vision capability + ADR-3 error;
  `NORTH-STAR`/feature docs touch-up if applicable.

---

## Dependency graph

```
01 vision-llm ──► 03 endpoint ──► 04 api-client ──► 05 tracer-flow ──► 08 multi-page ──► 09 progressive
02 prompt    ──┘                                      │  │  │
                                                      │  │  └────────► 10 camera
06 backdating ──► 07 date-picker ◄────────────────────┘  └───────────► 11 downscale+cleanup
03 endpoint  ────────────────────────────────────────────────────────► 12 privacy-suite
```

- 01+02 can proceed in parallel; 06 is independent and can start any time.
- Demoable at: end of 05 (single photo), 07 (dated), 09 (multi-page), 10/11
  (camera + polish). 12 lands before feature flag/rollout.

## Total estimated scope

~12 issues, ~2,540 LoC across backend and frontend, no schema changes except
issue 06's index migration, two new frontend dependencies (issue 11), zero
new backend dependencies.

## Open product questions (flagged for the reviewer, not blocking Phase 1)

1. **Wallet charging:** a 10-page session ≈ 10 resonance calls of provider
   cost (research § R5), but transcription is currently unpriced. Charge per
   page, per session, or free-while-beta? (Wiring exists:
   `preflight_deduction`, `services/wallet.py:297`.)
2. **`intimate` classification:** resonance is blocked for intimate entries;
   transcription of an intimate handwritten page still sends content to the
   LLM. Should the capture flow offer the classification picker *before*
   transcription, and if `intimate` is chosen, warn (or block) accordingly?
3. **Provider-side retention:** image retention at the provider is governed
   by account settings, not API parameters (research § R4 seam 8). Accepting
   this boundary should be an explicit product sign-off.

## Acceptance snapshot (from the scoping doc — end state)

> User photographs three unlined pages of messy handwriting, picks "July 12"
> as the date, reviews and fixes two words in the preview, taps Save. The
> entry appears in the journal dated July 12, the autosave indicator reads
> saved, "Get Resonance" is tappable, and no image bytes exist anywhere in
> the system.

Covered by: 10 (photograph) + 08/09 (three pages, review/fix) + 06/07
(July 12) + 05 (save → saved hint → resonance) + 11/12 (no image bytes
anywhere).
