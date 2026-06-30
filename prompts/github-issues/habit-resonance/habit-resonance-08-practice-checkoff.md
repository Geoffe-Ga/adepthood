# habit-resonance-08: Extend detection + accept to practices (journal-attested `PracticeSession`)

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** 03 (candidate seam), 05 (accept verb), 07 (card) ·
**Scope:** Full-stack · **Est. LoC:** ~240

## Problem

Habits ship in 01–07. This issue turns on the second target type: detect when
the writer describes doing one of their **practices** (a meditation sit, a tarot
draw, a breathing session) and let **OK** log a `PracticeSession`. The card and
detection plumbing already handle a `practice` target type — this fills in the
two dormant seams (candidate gathering + accept) and the practice-specific
session shape.

## Tasks

### 1. Turn on practice candidates (issue 03 seam)

- In `run_resonance` (`routers/journal.py`), call
  `gather_candidates(session, current_user, include_practices=True)`.
- In `services/completion_candidates.py`, implement the practice branch: the
  user's **active** `UserPractice` rows (`end_date IS NULL`) →
  `DetectionCandidate(target_type="practice", target_id=<user_practice_id>,
  name=<custom_name or practice.name>)`. Resolve the practice display name
  (reuse `domain.practice_resolution` / the practice catalog lookup; don't
  hand-roll name resolution). Habits + practices share the single
  `MAX_CANDIDATES` budget; keep indices dense.

### 2. Practice accept (issue 05 seam) — `POST /journal/suggestions/{id}/accept`

Replace the `practice_accept_not_supported` placeholder with the real path:

- Load the suggestion's `user_practice_id` (ownership-scoped; 404 if it or its
  practice is gone or the practice was since closed/reassigned — reuse the
  practice-session router's `_resolve_*` ownership helpers).
- Resolve the session shape via the existing practice-session creation path
  (`routers/practice_sessions.py` / `_build_practice_session`,
  `_resolve_practice_with_mode`): denormalize the resolved `mode`, set
  `completed=True`, and set `duration_minutes` to the practice's **target
  duration** when resolvable (from the recipe/mode config), else a named
  `JOURNAL_ATTESTED_DEFAULT_MINUTES` constant. Stamp
  `mode_metadata={"attested_via": "journal", "journal_entry_id": <id>}` so a
  journal-attested session is distinguishable from a timer session, and validate
  it through the same `SessionMetadata` edge if a mode requires metadata (for
  metadata-required modes, fall back to the minimal valid payload).
- Use a deterministic idempotency key (`accept-suggestion:practice:{id}`) so a
  retried OK reuses the prior session (reuse the practice-session idempotency
  layer rather than adding a new one). Flip the suggestion to `accepted`,
  `accepted_at=now`.
- Return `AcceptSuggestionResponse` — for practices there's no streak; populate
  `check_in=null` (make the field optional) so the card shows a plain "✓ Checked
  off" without a streak line. Adjust issue 06/07 types accordingly (optional
  `check_in`).
- Log `completion_suggestion_accepted` with `target_type="practice"`.

### 3. Card copy (issue 07)

`CompletionSuggestionNote` already reads `note.label`; confirm the question and
confirmed states read naturally for a practice ("You wrote about **Morning
sit**. Check it off?" → "✓ Logged"). If habit vs practice deserve slightly
different verbs, branch on `note.target_type` with named copy constants. No new
component.

## Tasks — tests

- **Backend** (`test_completion_candidates.py`): `include_practices=True` yields
  practice candidates for active `UserPractice` rows (custom_name preferred);
  closed practices (`end_date` set) excluded; habits + practices share the cap.
- **Backend** (`test_completion_suggestion_endpoints.py`): accept a pending
  practice suggestion ⇒ a `PracticeSession` with `completed=True`,
  `mode_metadata.attested_via == "journal"`, sane `duration_minutes`; idempotent
  (one session on double-accept); `check_in` is null; ownership/closed-practice
  edge ⇒ 404.
- **Frontend**: a practice suggestion renders the question/label and OK logs it;
  the confirmed state shows no streak line when `check_in` is null.

## Acceptance criteria

- [ ] Practices the writer describes doing surface as check-off suggestions and
      **OK** logs a journal-attested `PracticeSession` (completed, marked
      `attested_via: journal`, deduped idempotently).
- [ ] Practice candidate gathering covers active practices only and shares the
      habit candidate budget; name resolution reuses existing practice logic.
- [ ] The card reads naturally for practices (no streak line when none applies).
- [ ] `./scripts/backend/check-all.sh` and `./scripts/frontend/check-all.sh`
      green; existing practice-session and habit-suggestion tests unchanged.

## Files

| File | Action |
|------|--------|
| `backend/src/services/completion_candidates.py` | Modify — implement the practice branch |
| `backend/src/routers/journal.py` | Modify — `include_practices=True`; real practice accept |
| `backend/src/schemas/completion_suggestion.py` | Modify — optional `check_in` |
| `backend/tests/test_completion_candidates.py` | Modify |
| `backend/tests/test_completion_suggestion_endpoints.py` | Modify |
| `frontend/src/api/schemas.ts` | Modify — `check_in` optional on `AcceptSuggestionResult` |
| `frontend/src/features/Journal/CompletionSuggestionNote.tsx` | Modify — practice copy + no-streak state |
| `frontend/src/features/Journal/__tests__/CompletionSuggestionNote.test.tsx` | Modify |

## Constraints

- **Reuse the practice-session creation + idempotency + mode-resolution path**;
  do not hand-roll session building or a parallel dedupe. A journal-attested
  session must be flagged (`attested_via: journal`) so analytics can tell it
  from a timer-tracked sit. Practices have no streak — keep `check_in` optional
  end-to-end rather than faking one.
