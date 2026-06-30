# habit-resonance-04: Wire detection into the resonance endpoint + list + re-anchor

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** 01 (model), 02 (detection), 03 (candidates) ·
**Scope:** Backend · **Est. LoC:** ~260

## Problem

`POST /journal/{id}/resonance` runs the literary pass, charges one unit, and
returns marginalia. This issue makes the **same press** also run completion
detection, persist `CompletionSuggestion` rows, and return them — additively,
best-effort, on the same single charge — plus a list endpoint and re-anchoring
of pending suggestions when the body is edited.

## Tasks

### 1. Response schema — `backend/src/schemas/completion_suggestion.py`

- `CompletionSuggestionResponse(BaseModel)` with: `id`, `journal_entry_id`,
  `target_type: CompletionTargetType`, `goal_id`, `user_practice_id`, `label`,
  `anchor_start`, `anchor_end`, `anchor_text`, `status: SuggestionStatus`,
  `accepted_at`, `created_at`, `updated_at`. **Never** include `user_id`
  (mirror `MarginaliaResponse`).
- `CompletionSuggestionListResponse(items=[…])`.
- Extend `schemas/marginalia.ResonanceResponse` with
  `suggestions: list[CompletionSuggestionResponse] = []`.

### 2. Detection in `run_resonance` (`backend/src/routers/journal.py`)

After the literary `generate_marginalia` succeeds and **before the single
commit**:

- `candidates = await gather_candidates(session, current_user)` (habits only;
  `include_practices` stays default until issue 08).
- Run detection best-effort:
  ```python
  detected = []
  if candidates:
      try:
          detected = await detect_completions(entry.message, candidates=candidates, llm=llm)
      except LLMProviderError:
          logger.warning("completion_detection_failed", extra={...})
          detected = []   # literary notes + charge unaffected
  ```
  Reuse the same `llm` instance already built for the literary pass — **no
  second key resolution, no second charge.** No candidates ⇒ no LLM call.
- Persist one `CompletionSuggestion` per hit (status `PENDING`, `label` from the
  hit, the matching `goal_id`/`user_practice_id` set per `target_type`),
  staged in the same session as the marginalia so they commit atomically.
- Refresh and include them in `ResonanceResponse.suggestions`. Log
  `completion_suggestions_generated` with the count.

> **Charge invariant:** the literary pass remains the only thing that can 502 /
> roll back the deduction. A detection failure is swallowed to `[]`. Keep this
> explicit in a comment — it's the rule the epic promises.

### 3. List endpoint — `GET /journal/{id}/suggestions`

Mirror `list_marginalia`: load the caller's own non-deleted entry (404 scope),
return its suggestions ordered by `anchor_start` as
`CompletionSuggestionListResponse`. Scope by both the entry and the
denormalized `user_id` (defense in depth).

### 4. Re-anchor pending suggestions on edit

In `services/marginalia.reanchor_entry_marginalia` (or a sibling
`reanchor_entry_suggestions` called from the same `_apply_entry_update` seam),
re-anchor **pending** suggestions using `domain.marginalia_anchoring.reanchor_one`
on `anchor_text`:

- Anchor moved ⇒ update `anchor_start/anchor_end`.
- Anchor text gone ⇒ the writer deleted the mention; auto-flip the **pending**
  suggestion to `DISMISSED` (it no longer has a referent). `accepted`/`dismissed`
  rows are left untouched. Document this choice in the docstring.

## Tasks — tests

- `test_resonance_endpoints.py` (extend): a fake LLM returning one literary note
  **and** (via the candidate set) one detection hit ⇒ response has both
  marginalia and one `suggestions` entry (PENDING, correct `goal_id`/`label`,
  `user_id` absent); a row persists.
- Detection `LLMProviderError` ⇒ marginalia still returned, charge still
  applied, `suggestions == []` (assert no rollback).
- User with no habits ⇒ detection LLM **not** called (patch/spy), `suggestions
  == []`.
- `GET /journal/{id}/suggestions`: lists ordered by anchor; 404 for another
  user's / missing / soft-deleted entry.
- Re-anchor: editing the body so a suggestion's `anchor_text` shifts updates its
  offsets; deleting the sentence flips a pending suggestion to `dismissed` and
  leaves an already-`accepted` one alone.

## Acceptance criteria

- [ ] One "Get Resonance" press returns literary marginalia **and** completion
      suggestions on a single charge; suggestions persist as PENDING rows.
- [ ] No candidates ⇒ no detection LLM call; detection failure ⇒ suggestions
      empty, literary pass + charge intact (no rollback).
- [ ] `GET /journal/{id}/suggestions` lists them (ownership-scoped, ordered,
      `user_id` never returned).
- [ ] Editing re-anchors pending suggestions; a deleted mention auto-dismisses.
- [ ] `./scripts/backend/check-all.sh` green; rate-limit/wallet behavior of the
      resonance route otherwise unchanged.

## Files

| File | Action |
|------|--------|
| `backend/src/schemas/completion_suggestion.py` | New — response schemas |
| `backend/src/schemas/marginalia.py` | Modify — `ResonanceResponse.suggestions` |
| `backend/src/routers/journal.py` | Modify — detection in `run_resonance`, list endpoint, re-anchor call |
| `backend/src/services/marginalia.py` | Modify — re-anchor pending suggestions seam |
| `backend/tests/test_resonance_endpoints.py` | Modify — both-streams, best-effort, no-candidates, list, re-anchor |

## Constraints

- Reuse the single `BotmasonResonanceLLM` already built in `run_resonance`; no
  second charge, no second key resolution. Atomic commit with the marginalia.
- The literary pass stays the sole 502/rollback trigger; detection is swallowed.
- Re-anchoring reuses `reanchor_one`; no new anchoring logic.
