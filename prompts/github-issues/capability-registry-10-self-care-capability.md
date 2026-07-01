# capability-registry-10: First new capability — self-care strategies (proof of pluggability)

**Labels:** `enhancement`, `feature`, `backend`, `frontend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 04, 05, 06, 07
**Estimated LoC:** ~300

## Role

You are a full-stack engineer shipping the first feature born *inside* the
capability registry — and, in doing so, proving the epic's core promise: a new
opt-in feature is **one capability registration + one manifest entry**, with the
journal pipeline, suggestion inbox, opt-in gating, and accept path all working
without a single edit to core files.

## Goal

A minimal **self-care strategies** feature (named in NORTH-STAR's Neurospicy
persona: "tools, techniques, self-care"): the user keeps a small list of
personal strategies ("call a friend", "walk outside", "hot shower", "stretch"),
and writing about having used one in a journal entry surfaces a confirmable
"log this self-care moment?" proposal. Logged moments accumulate into a simple
history. Deliberately tiny — this issue's value is the *proof*, not feature
depth.

## Context

By this point the pipeline is generic: candidates come from the registry (04),
proposals are `ActionSuggestion`s (03), accept dispatches to the capability's
`execute` (05), the tab derives from the manifest (06), and proposals render in
the shared inbox (07). This issue exercises every seam end to end as a *new*
target type — the regression-canary for "is it actually pluggable?"

## Tasks

1. **Model:** `SelfCareStrategy` (id, user_id FK CASCADE, name ≤255, optional
   icon, `sort_order`, timestamps) and `SelfCareLog` (id, strategy FK CASCADE,
   user_id, `logged_at`, optional `journal_entry_id` provenance). Migration.
2. **Router:** `routers/self_care.py` — CRUD for strategies (owned, paginated
   per house pattern) + list logs. Seed nothing; strategies are personal.
3. **Capability registration** (`domain/capability_defs.py`): key `self_care`,
   flag `self_care`, verb `log` (empty params v1). `candidates()` returns the
   user's strategies; `execute` writes a `SelfCareLog` (with
   `journal_entry_id` provenance from the suggestion).
4. **Frontend:** feature folder `features/SelfCare/` (list + add/edit + simple
   history), one `FEATURES` manifest entry (`slot: 'ring'`), store with
   `registerStoreReset`, API client + zod schemas.
5. **The proof, enforced by tests:**
   - Backend: a journal entry mentioning a strategy ("took a long walk after
     lunch") yields a pending `self_care.log` proposal; accepting writes the
     log — with **zero modifications** to `detection.py`, the suggestions
     router, or `main.py` beyond the standard module mount + capability import.
   - Frontend: the tab, its opt-out toggle, and inbox rendering work with
     **zero modifications** to `BottomTabs.tsx`, the inbox, or the
     depth-preferences store (no new column — flag rides 02's generic
     `disabled_features`).
   - Add a CI-friendly meta-test (or PR checklist assertion) enumerating which
     core files the diff may touch.

## Acceptance Criteria

- [ ] Feature ships with no new depth-preference column and no edits to detection, inbox, accept endpoint, or tab assembly internals.
- [ ] Journal mention → proposal → accept → logged moment, end to end, via the generic pipeline.
- [ ] Opt-out hides the tab and removes its candidates from detection.
- [ ] Deleting a strategy cleans up its pending proposals (per 03's dangling-target policy).
- [ ] Quiet by design: no streaks, no pressure copy — a log is a private note, not a score.
- [ ] `pytest backend/` + frontend suite + `pre-commit run --all-files` green.

## Files

| File | Action |
|------|--------|
| `backend/src/models/self_care.py` | **Create** |
| `backend/src/routers/self_care.py` | **Create** |
| `backend/src/schemas/self_care.py` | **Create** |
| `backend/src/domain/capability_defs.py` | Modify (register) |
| `backend/migrations/versions/<rev>_self_care.py` | **Create** |
| `frontend/src/features/SelfCare/` | **Create** |
| `frontend/src/features/manifest.ts` | Modify (one entry) |
| `backend/tests/test_self_care.py` | **Create** |

## Constraints

- If this issue *needs* a core-file change to work, that is a bug in 01–07 —
  fix it there (and note it), don't patch around it here.
- Keep v1 scope austere: no reminders, no analytics, no sharing. Depth can come
  later as its own issues.
