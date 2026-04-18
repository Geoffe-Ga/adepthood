# Weekly Prompts Bug Report — 2026-04-18

**Scope:** `backend/src/routers/prompts.py` (207 LOC), `backend/src/domain/weekly_prompts.py` (102 LOC). Supporting: `backend/src/models/prompt_response.py` (32 LOC), `backend/src/schemas/prompt.py` (33 LOC). Covers the weekly reflection surface: deriving "current week," reading prompt/response pairs, submitting responses (which also mirror into `journal_entry`), and paginating history.

**Total bugs: 10 — 0 Critical / 2 High / 6 Medium / 2 Low**

## Executive Summary

1. **No unlock gate on `/respond` + naive `max(week_number)+1` derivation yields curriculum skip-ahead (High).** BUG-PROMPT-001: `_get_user_week` returns `max(completed_weeks)+1` clamped to `[1, 36]`, and `submit_prompt_response` accepts any `week_number` the dict knows. A fresh user can POST to `/prompts/36/respond`, and their "current week" jumps to 36 on the next read — the entire 36-week pacing is voided in a single request.
2. **All 36 prompts readable from day one (High).** BUG-PROMPT-002: `get_prompt_by_week` does not gate by the user's current week. The full 36-prompt curriculum leaks to a week-1 user on a trivial enumerate loop, undermining the program's weekly-release design.
3. **Unsanitized response persists to two tables (Medium).** BUG-PROMPT-003: `submit_prompt_response` stores `payload.response` verbatim into both `PromptResponse` and a mirrored `JournalEntry`. Combined with BUG-JOURNAL-003 (no HTML/script escape on journal rendering or LLM input), this is a second authorized entry point to the same stored-XSS / prompt-injection surface.
4. **Error-code inconsistency on duplicate responses (Medium).** BUG-PROMPT-004: the pre-check returns `400 already_responded`; the `IntegrityError` path returns `409 already_responded`. Clients see different HTTP codes for the same logical condition depending on timing.
5. **Validation gaps + polish (Medium/Low).** BUG-PROMPT-005 (`min_length=1` without stripping → `"   "` passes), BUG-PROMPT-006 (unbounded `offset` in history), BUG-PROMPT-008 (weekly responses tagged `STAGE_REFLECTION` pollutes stage-scoped aggregates), BUG-PROMPT-010 (prompt text drift between historical row and live dict), BUG-PROMPT-007 (corrupted UTF-8 on `domain/weekly_prompts.py:33`), BUG-PROMPT-009 (`TOTAL_WEEKS=36` duplicates `TOTAL_STAGES` — no single source of truth).

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-PROMPT-001 | High | `routers/prompts.py` | `max(week)+1` + no unlock gate → skip-ahead |
| 2 | BUG-PROMPT-002 | High | `routers/prompts.py` | `get_prompt_by_week` leaks full 36-week curriculum |
| 3 | BUG-PROMPT-003 | Medium | `routers/prompts.py` | Unsanitized response stored in two tables |
| 4 | BUG-PROMPT-004 | Medium | `routers/prompts.py` | 400 vs 409 inconsistency on duplicate |
| 5 | BUG-PROMPT-005 | Medium | `schemas/prompt.py` | `min_length=1` accepts whitespace-only response |
| 6 | BUG-PROMPT-006 | Medium | `routers/prompts.py` | `list_prompt_history` offset unbounded |
| 7 | BUG-PROMPT-007 | Low | `domain/weekly_prompts.py` | Corrupted UTF-8 on week-10-12 heading |
| 8 | BUG-PROMPT-008 | Medium | `routers/prompts.py` | Weekly response tagged `STAGE_REFLECTION` |
| 9 | BUG-PROMPT-009 | Low | `domain/weekly_prompts.py` | `TOTAL_WEEKS` duplicates `TOTAL_STAGES` |
| 10 | BUG-PROMPT-010 | Medium | `routers/prompts.py` | Historical `question` can drift from live dict |

---

## Prompts router — `routers/prompts.py`

### BUG-PROMPT-001 — `max(week)+1` + no unlock gate on `/respond` enables curriculum skip-ahead
- **Severity:** High
- **Component:** `backend/src/routers/prompts.py:27-40`, `backend/src/routers/prompts.py:144-207`
- **Symptom:** A brand-new user (with zero `PromptResponse` rows) can `POST /prompts/36/respond` and their "current week" permanently becomes week 36. The entire 36-week weekly-reflection pacing is bypassed in a single request.
- **Root cause:**
  ```python
  async def _get_user_week(session: AsyncSession, user_id: int) -> int:
      result = await session.execute(
          select(func.max(PromptResponse.week_number)).where(PromptResponse.user_id == user_id)
      )
      max_week = result.scalar()
      week = int(max_week) + 1 if max_week is not None else 1
      return int(max(1, min(week, TOTAL_WEEKS)))
  ```
  `submit_prompt_response` (L149-207) only checks `get_prompt_for_week(week_number) is not None` — any `week_number` in `[1, 36]` is accepted regardless of the user's progress. `_get_user_week` then trusts `max(week_number)` as the canonical "completed through," so a single response to week 36 is indistinguishable from having completed weeks 1-35.
- **Fix:** Gate `/respond` on `week_number == _get_user_week(session, user_id)` (or `<= current_week`). Derive current week from `len(completed_weeks)+1` (counting, not max), and track completions as an explicit ordered set rather than deriving from an unbounded `MAX()`. Cross-ref BUG-STAGE-001 for the parallel stage-unlock chain bypass.

### BUG-PROMPT-002 — `get_prompt_by_week` leaks the full 36-week curriculum
- **Severity:** High
- **Component:** `backend/src/routers/prompts.py:116-141`
- **Symptom:** A week-1 user enumerating `GET /prompts/1`, `/prompts/2`, ... `/prompts/36` receives every future prompt verbatim. The program's weekly-release design (one reflection per week for 36 weeks) is voided.
- **Root cause:**
  ```python
  @router.get("/{week_number}", response_model=PromptDetail)
  async def get_prompt_by_week(
      week_number: int,
      current_user: int = Depends(get_current_user),
      session: AsyncSession = Depends(get_session),
  ) -> PromptDetail:
      question = get_prompt_for_week(week_number)
      if question is None:
          raise not_found("prompt")
      # ... no week-vs-user-progress check
  ```
  The endpoint returns the prompt text for any `week_number` in `[1, 36]` with no comparison against the user's current week. Sibling endpoints in the stages/course routers gate content reads via `_check_stage_unlocked`; this router has no equivalent.
- **Fix:** Add an unlock check: reject (`403 prompt_locked`) when `week_number > await _get_user_week(session, user_id)`. If historical/past prompts should remain accessible, permit `<=` current but never `>` current.

### BUG-PROMPT-003 — Unsanitized `response` persisted to two tables + mirrored into journal pipeline
- **Severity:** Medium
- **Component:** `backend/src/routers/prompts.py:170-186`, `backend/src/schemas/prompt.py:22-25`
- **Symptom:** A response containing HTML/script/markdown (e.g. `<script>alert(1)</script>` or LLM-prompt-injection payloads) is stored verbatim into `PromptResponse.response` AND copied into a `JournalEntry.message` in the same commit. Any downstream view or LLM prompt that renders/includes journal text executes or ingests the payload.
- **Root cause:**
  ```python
  prompt_response = PromptResponse(
      week_number=week_number, question=question,
      response=payload.response, user_id=current_user,
  )
  session.add(prompt_response)
  journal_entry = JournalEntry(
      message=payload.response, sender="user",
      user_id=current_user, tag=JournalTag.STAGE_REFLECTION,
  )
  session.add(journal_entry)
  ```
  `PromptSubmit.response` has `min_length=1, max_length=10_000` but no HTML stripping or allowlist. Same flaw as BUG-JOURNAL-003; this endpoint is a second authorized insertion point that bypasses any fix applied only to the journal router.
- **Fix:** Centralize sanitization (bleach with an empty tag allowlist, or a shared `sanitize_user_text()` helper). Apply on write at every entry point that populates `JournalEntry.message` or `PromptResponse.response`, not at render-time. Cross-ref BUG-JOURNAL-003.

### BUG-PROMPT-004 — 400 vs 409 inconsistency on duplicate responses
- **Severity:** Medium
- **Component:** `backend/src/routers/prompts.py:160-192`
- **Symptom:** Clients receive `400 already_responded` when the pre-check catches the duplicate, but `409 already_responded` when the race hits the unique-constraint path. Two HTTP codes for the same logical condition breaks idempotent retry clients that only handle one.
- **Root cause:**
  ```python
  if result.scalars().first() is not None:
      raise bad_request("already_responded")     # 400
  # ...
  try:
      await session.commit()
  except IntegrityError:
      await session.rollback()
      raise conflict("already_responded") from None  # 409
  ```
- **Fix:** Pick one code for both paths. `409 Conflict` is the HTTP-correct choice for a state conflict; return it from the pre-check too. Alternatively, drop the pre-check entirely and rely on the unique constraint + `IntegrityError` (one round-trip, one code). Cross-ref BUG-GOAL-001 / BUG-COURSE-002 for the same TOCTOU-plus-unique-constraint pattern.

### BUG-PROMPT-005 — `min_length=1` accepts whitespace-only response
- **Severity:** Medium
- **Component:** `backend/src/schemas/prompt.py:22-25`
- **Symptom:** A user POSTs `{"response": "   "}` (three spaces) and the API accepts it as a valid reflection, incrementing their current week. Combined with BUG-PROMPT-001 this is a trivial 36-call auto-advance script.
- **Root cause:**
  ```python
  class PromptSubmit(BaseModel):
      response: str = Field(min_length=1, max_length=PROMPT_RESPONSE_MAX_LENGTH)
  ```
  Pydantic's `min_length` counts raw characters including whitespace. No `str.strip()` validator, no minimum meaningful-content check.
- **Fix:** Add a `@field_validator("response")` that rejects strings whose `.strip()` is shorter than a threshold (e.g. 10 chars). Apply the same pattern to `JournalCreate.message` for consistency.

### BUG-PROMPT-006 — `list_prompt_history` `offset` unbounded
- **Severity:** Medium
- **Component:** `backend/src/routers/prompts.py:72-98`
- **Symptom:** A client can POST `?offset=1000000000&limit=1` and force the DB to OFFSET a billion rows. Minor DoS vector; more importantly the count subquery runs on every request regardless of whether the client even paginates.
- **Root cause:**
  ```python
  @dataclass
  class _HistoryFilters:
      limit: int = Query(default=50, ge=1, le=200)
      offset: int = Query(default=0, ge=0)
  ```
  `offset` has a lower bound but no upper cap. A well-behaved user will never exceed 36 responses, so any offset > `TOTAL_WEEKS` is provably empty. Additionally, the `count()` subquery is run unconditionally on every page.
- **Fix:** Clamp `offset` to `le=TOTAL_WEEKS` (36). Skip the `count()` when the caller sets `?include_total=false` (cursor-style pagination) — for a 36-item ceiling, a simple `SELECT *` and client-side total is cheaper.

### BUG-PROMPT-008 — Weekly response tagged `STAGE_REFLECTION` pollutes stage-scoped aggregates
- **Severity:** Medium
- **Component:** `backend/src/routers/prompts.py:180-186`
- **Symptom:** Every weekly prompt submission creates a `JournalEntry` with `tag=JournalTag.STAGE_REFLECTION`. If `/journal` aggregates or filters by `STAGE_REFLECTION` to report per-stage reflection counts (or feeds stage summaries to BotMason), weekly prompts are silently double-counted as stage reflections.
- **Root cause:**
  ```python
  journal_entry = JournalEntry(
      message=payload.response, sender="user",
      user_id=current_user, tag=JournalTag.STAGE_REFLECTION,
  )
  ```
  Weekly prompts and stage-transition reflections are semantically different events (weekly cadence vs. stage-complete cadence) but share a single tag. Downstream filters cannot distinguish them.
- **Fix:** Introduce `JournalTag.WEEKLY_PROMPT` and use it here. Back-fill historical rows via a one-shot migration. Audit any journal aggregation queries that filter on `STAGE_REFLECTION` to ensure they continue to mean what they intended.

### BUG-PROMPT-010 — Historical `question` can drift from live dict
- **Severity:** Medium
- **Component:** `backend/src/routers/prompts.py:171-175`, `backend/src/models/prompt_response.py:24-25`
- **Symptom:** The `PromptResponse` row snapshots `question` at submission time; subsequent edits to `WEEKLY_PROMPTS` do not propagate. `/prompts/current` reads the live dict while `/prompts/history` reads the snapshot — a user who submitted before a prompt revision sees the old text in history and the new text on the current-week page for the same week number.
- **Root cause:**
  ```python
  # router (write path):
  prompt_response = PromptResponse(
      week_number=week_number, question=question, response=payload.response, ...
  )
  # get_current_prompt (read path):
  question = get_prompt_for_week(week)    # live dict
  ```
  Two sources of truth (column vs. dict) for the same datum.
- **Fix:** Pick one source of truth. Either (a) stop persisting `question` — always derive from the dict, versioned by week, or (b) introduce a `prompt_version` table and persist `(week, version_id)` on the response so the UI can resolve the exact text shown at submission. (a) is simpler; (b) is safer if prompts are editable.

---

## Domain — `domain/weekly_prompts.py`

### BUG-PROMPT-007 — Corrupted UTF-8 on week-10-12 heading
- **Severity:** Low
- **Component:** `backend/src/domain/weekly_prompts.py:33`
- **Symptom:** The week-10-12 section header reads `# Blue �� Order / Structure` — two U+FFFD replacement characters where an em-dash (`—`) should be, inconsistent with every other section header in the same file. Renders as mojibake in any viewer that surfaces comments (IDE outline, `--help` output if documented, etc.).
- **Root cause:**
  ```python
  # Blue — Order / Structure     # line 33 in git (other sections)
  # Blue �� Order / Structure     # actual content
  ```
  Looks like a byte-level save artifact — likely a previous edit in a non-UTF-8 editor clobbered the em-dash.
- **Fix:** Replace the two replacement chars with `—` (U+2014). Add a pre-commit hook or a test that fails on `\uFFFD` anywhere in `backend/src/`.

### BUG-PROMPT-009 — `TOTAL_WEEKS = 36` duplicates `TOTAL_STAGES`
- **Severity:** Low
- **Component:** `backend/src/domain/weekly_prompts.py:97`, cross-ref `backend/src/domain/stage_progress.py`
- **Symptom:** Two constants (`TOTAL_WEEKS` here, `TOTAL_STAGES` in `stage_progress.py`) both encode "36" with no central definition. If the program ever runs at a different cadence (e.g. a 12-week version), the two can drift silently.
- **Root cause:**
  ```python
  TOTAL_WEEKS = 36
  ```
  No reference from a single `PROGRAM_LENGTH` constant or config.
- **Fix:** Define `PROGRAM_WEEKS = 36` once (e.g. in `domain/__init__.py` or a `config.py`) and re-export. Assert at import time that `len(WEEKLY_PROMPTS) == PROGRAM_WEEKS` to catch seed-data regressions.

---

## Suggested Remediation Order

1. **BUG-PROMPT-001 (High)** — Gate `/respond` on `week_number <= current_week` and switch `_get_user_week` to `len(completed)+1`. Breaks the skip-ahead chain.
2. **BUG-PROMPT-002 (High)** — Add the same unlock check to `get_prompt_by_week`. Same code path as #1 — factor into a shared dependency.
3. **BUG-PROMPT-003 (Medium)** — Centralize `sanitize_user_text()` and call it in both `submit_prompt_response` and `POST /journal` (the fix for BUG-JOURNAL-003). Apply on write, not render.
4. **BUG-PROMPT-008 (Medium)** — Introduce `JournalTag.WEEKLY_PROMPT`; back-fill historical rows; audit journal aggregates.
5. **BUG-PROMPT-004 (Medium)** — Drop the pre-check; rely on the `IntegrityError` + 409 path only. One round-trip, one error code.
6. **BUG-PROMPT-005 (Medium)** — Add a `strip()`-aware validator on `PromptSubmit.response` and `JournalCreate.message`.
7. **BUG-PROMPT-010 (Medium)** — Stop persisting `question`; always resolve from the dict. Drop the column in a migration once backfilled.
8. **BUG-PROMPT-006 (Medium)** — Cap `offset` at `TOTAL_WEEKS`; make `count()` optional.
9. **BUG-PROMPT-007 (Low)** — Fix the mojibake; add a `\uFFFD` lint.
10. **BUG-PROMPT-009 (Low)** — Hoist `PROGRAM_WEEKS` to a single definition; assert seed length.

## Cross-References

- **BUG-PROMPT-001 ↔ BUG-STAGE-001 / BUG-SCHEMA-006** — Parallel skip-ahead pattern: unlock gate derives progress from a client-writable or `MAX()`-based signal with no chain validation. The three together form the curriculum-pacing bypass family.
- **BUG-PROMPT-003 ↔ BUG-JOURNAL-003** — The weekly-prompt endpoint is a second authorized path into the same stored-XSS / prompt-injection surface. Any fix in the journal router must also be applied here.
- **BUG-PROMPT-004 ↔ BUG-GOAL-001 / BUG-COURSE-002** — Identical TOCTOU-plus-unique-constraint pattern; consolidate on the DB-constraint-only approach and return a single error code everywhere.
- **BUG-PROMPT-008 ↔ BUG-JOURNAL-006** — Both concern the `JournalTag` taxonomy being too coarse for downstream aggregates.
- **BUG-PROMPT-010 ↔ BUG-BM-014** — Persisted-vs-live copy of a datum is the same class of drift bug as BotMason's system-prompt history replay; fix by naming a single source of truth.
