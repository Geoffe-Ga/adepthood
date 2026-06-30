# Epic: Check off habits & practices from the journal's resonance pass

Follow-on to the completed **Journal Resonance** epic (#603). That epic turned
the journal into a long-form page the AI reads and annotates with anchored
**marginalia** (theme / connection / symbol). This epic teaches the *same*
"Get Resonance" press to also notice when the writer describes **doing one of
their tracked habits or practices** and offer to check it off — a margin
comment that pops up next to the sentence and asks a single yes/no question:

> **Habit work detected. Check it off?** → **OK**

Tapping **OK** logs the completion (a `GoalCompletion` for the habit, a
`PracticeSession` for a practice) exactly as the check-in screen would, and the
margin note settles into a confirmed "✓ Checked off" state. The user never
leaves the page they were writing on.

## Product shape

1. The user writes an entry, e.g. *"Did my 20-minute morning sit and finally
   went for the run I keep skipping."*
2. They press **Get Resonance** (the existing floating button).
3. Alongside the literary margin notes, the AI now also surfaces **completion
   suggestions** — one per detected habit/practice mention — pinned to the span
   that triggered them ("the run I keep skipping" → *Daily run*).
4. Each suggestion renders **as marginalia**: a small card reading
   *"You wrote about **Daily run**. Check it off?"* with a clear **OK** and a
   quiet **Not now**.
5. **OK** records today's completion (idempotent — one per goal/day), the card
   becomes *"✓ Checked off — 4-day streak"*; **Not now** dismisses it.
6. Editing the entry re-anchors pending suggestions, or auto-dismisses one whose
   sentence was deleted (same re-anchor machinery as marginalia).

Nothing about the existing literary resonance changes — completion detection is
**additive and best-effort**: it rides the same single wallet charge, is skipped
entirely when the user has no active habits/practices, and a detection-only LLM
hiccup never costs the user their margin notes.

## Why a separate model (not a new marginalia kind)

Completion suggestions *render* as marginalia but are **not** literary notes:
they link to a habit goal / user-practice, carry an accept→dismiss lifecycle
with a real side effect (logging a completion), and must never pollute the
`theme|connection|symbol` enum or its drift-guard test. So they live in their
own `completion_suggestion` table, reusing the marginalia **anchoring** domain
(`domain/marginalia_anchoring.reanchor_one`, verbatim-quote span resolution) and
the same margin-rendering language. Storage is separate; presentation is shared.
The rejected alternative — extending `Marginalia` with nullable target columns
and a fourth kind — was heavier (relax the CHECK, migrate the enum, complicate
the well-tuned literary prompt) for no lifecycle benefit.

## Canonical contract (every sub-issue depends on these)

- **Enums:** `CompletionTargetType` = `habit|practice`;
  `SuggestionStatus` = `pending|accepted|dismissed`.
- **`completion_suggestion` table:** `id`, `journal_entry_id` (FK CASCADE),
  `user_id` (FK CASCADE), `target_type`, `goal_id` (FK `goal` CASCADE, nullable),
  `user_practice_id` (FK `userpractice` CASCADE, nullable), `label(255)`
  (display-name snapshot), `anchor_start`, `anchor_end`, `anchor_text(280)`,
  `status`, `accepted_at|null`, `created_at`, `updated_at`. CHECKs: exactly the
  FK matching `target_type` is set (`(target_type='habit') = (goal_id IS NOT
  NULL)` and the practice mirror); `anchor_start >= 0`; `anchor_end >
  anchor_start`; `target_type`/`status` value CHECKs derived from the enums
  (matching the `marginalia` precedent). Indexes on `journal_entry_id` and
  `user_id`.
- **Anchors** are character offsets + a verbatim `anchor_text` snapshot; the
  server resolves the model's quote to offsets itself and **never trusts
  model-supplied indices or offsets** — identical to `domain/resonance.py`.
- **Detection contract:** the LLM is handed a numbered candidate list (the
  user's active habits/practices) and returns, per hit, a `candidate` index +
  a verbatim `quote`. The server keeps a hit only if `candidate` is in range
  **and** `quote` anchors verbatim in the body; overlaps de-dupe (first wins),
  capped at 5. Detection requires evidence the work was *done* ("I sat for
  twenty minutes"), not merely planned ("I should meditate").
- **Endpoints:**
  - `POST /journal/{id}/resonance` — unchanged charge; response **gains**
    `suggestions: CompletionSuggestionResponse[]`.
  - `GET /journal/{id}/suggestions` — list the entry's suggestions.
  - `POST /journal/suggestions/{id}/accept` — log the completion, flip to
    `accepted`; idempotent.
  - `POST /journal/suggestions/{id}/dismiss` — flip to `dismissed`.
- **Accept policy:** habit → a `GoalCompletion` for the resolved goal
  (clear-tier; fallback the habit's first goal) at `completed_units = target`,
  dated today in the user's timezone, **idempotent per goal+day**, reusing the
  check-in recording path (so streak + milestones compute identically).
  Practice → a journal-attested `PracticeSession` (`completed=True`,
  `mode_metadata={"attested_via": "journal"}`) — sub-issue 08.
- **Best-effort rule:** no candidates ⇒ skip the detection LLM call (zero extra
  cost); detection `LLMProviderError` ⇒ zero suggestions, the literary pass and
  its charge are unaffected (the literary pass is still the only thing that can
  502 / roll back the charge).
- **Ownership/security:** `user_id` server-set and never returned; suggestions
  scoped to the caller (404 otherwise, enumeration-safe); AI-proposed `label`
  and quotes sanitized like all AI output.

## Sub-issues

**Backend**
- [ ] habit-resonance-01: `CompletionSuggestion` model + migration
- [ ] habit-resonance-02: Completion-detection domain service (LLM pass)
- [ ] habit-resonance-03: Active completion-candidate gathering service
- [ ] habit-resonance-04: Wire detection into the resonance endpoint + list + re-anchor
- [ ] habit-resonance-05: Accept / dismiss endpoints — habit check-off logs a `GoalCompletion`

**Frontend**
- [ ] habit-resonance-06: API client + types + `useResonance` surfacing
- [ ] habit-resonance-07: "Check it off?" margin card + OK / Not-now wiring

**Full-stack**
- [ ] habit-resonance-08: Extend detection + accept to practices (journal-attested `PracticeSession`)

## Dependency graph

```
Backend
  01 model ─────────────┐
  02 detection-domain ──┼── 04 endpoint-wiring ── 05 accept/dismiss (habit)
  03 candidate-service ─┘

Frontend
  04 (contract) ── 06 api-client ── 07 check-it-off-card

Full-stack
  03 + 05 + 07 ── 08 practice check-off
```

01, 02, 03 are independent and can land in any order (02 is pure domain, no DB).
Sub-issues are numbered in dependency order so Ralph's lowest-number-first
picker walks the graph naturally; 08 lands last because it extends both the
backend accept path and the frontend card to a second target type.

## Epic-level acceptance criteria

- [ ] Pressing **Get Resonance** on an entry that describes doing a tracked
      habit surfaces a margin card *"You wrote about **{habit}**. Check it
      off?"* pinned to the relevant span, alongside the literary notes.
- [ ] **OK** logs today's completion (idempotent per goal/day, streak/milestones
      identical to the check-in screen) and the card shows the confirmed state;
      **Not now** dismisses it and it doesn't reappear.
- [ ] Practices detected the same way log a journal-attested `PracticeSession`.
- [ ] Detection is additive: no active habits/practices ⇒ no extra LLM call;
      a detection failure still returns the literary marginalia and charges once.
- [ ] Editing the entry re-anchors pending suggestions; a suggestion whose
      sentence is deleted auto-dismisses.
- [ ] `./scripts/backend/check-all.sh` and `./scripts/frontend/check-all.sh`
      green on every sub-issue PR; coverage/branch/docstring thresholds
      unchanged; no new magic numbers; conventional commits.

## Constraints

- **Reuse, don't fork.** Anchoring → `domain/marginalia_anchoring`; the LLM seam
  → `services/marginalia.BotmasonResonanceLLM`; completion recording → the
  existing check-in path in `routers/goal_completions.py` (extract a service if
  needed, don't reimplement streak math); margin rendering → the
  `MarginNote`/`MarginNoteList` language.
- **One press = one charge.** Detection rides the resonance unit already
  deducted; it never adds a second charge and never gates literary notes.
- **The AI never writes the page** and never decides what counts as done — it
  only *proposes*; the user confirms with **OK**, and the server resolves every
  id/offset itself.
- **TDD + thresholds** per `CLAUDE.md`; one logical change per PR.

## References

- `backend/src/domain/resonance.py` — the literary pass + anchoring pattern to mirror
- `backend/src/domain/marginalia_anchoring.py` — `reanchor_one` (reused for suggestions)
- `backend/src/models/marginalia.py` + `backend/migrations/versions/f6e5d4c3b2a1_add_marginalia.py` — table + migration precedent
- `backend/src/routers/journal.py:337-404` — `run_resonance` + `list_marginalia` (extension points)
- `backend/src/routers/goal_completions.py` — the idempotent check-in recording path to reuse
- `backend/src/models/{habit,goal,goal_completion,user_practice,practice,practice_session}.py`
- `frontend/src/features/Journal/{useResonance.ts,MarginNote.tsx,JournalEntryScreen.tsx}`
- `frontend/src/api/index.ts:1231-1252` — the `resonance` client to extend
