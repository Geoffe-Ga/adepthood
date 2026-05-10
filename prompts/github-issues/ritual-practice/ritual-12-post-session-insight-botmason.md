# ritual-12: Post-session insight capture + BotMason CTA

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-medium`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-04 (session POST accepts metadata + insight),
ritual-11 (screen mounts the modal)
**Estimated LoC:** ~300

## Problem

Two product requirements converge here:

1. **Capture insights and analytics.** When a session completes, prompt the
   user for a short insight (one sentence — distinct from the long-form
   `reflection`) and POST it together with the mode-specific metadata.
2. **Users may want to journal after each practice — provide a link to
   BotMason.** A single CTA from the post-session modal that hands off to
   the Journal screen with the new session's id pre-attached, so BotMason
   can pick up the context.

## Scope

One modal, one analytics POST, one navigation hand-off. No new endpoints
(ritual-04 already covers the POST shape).

## Tasks

1. **`InsightCaptureModal.tsx`** —
   `frontend/src/features/Practice/components/InsightCaptureModal.tsx`
   - Props: `{ visible, mode, durationMinutes, modeMetadata, onSave,
     onSkip, onJournal }`.
   - Body:
     - "How did it land?" header.
     - Single-line `TextInput` (multiline allowed; soft cap 200 chars,
       hard cap 2,000 to match the backend column).
     - Mode-specific summary line (e.g. "108 breath cycles in 12:34" for
       rep counters, "BPM 60 for 30:00" for metronome). Compose via a tiny
       formatter `formatModeSummary(mode, durationMinutes, metadata)` —
       pure function, tested.
     - Three primary actions:
       - **"Save"** — calls `onSave(insight)`, which (in the parent screen)
         posts the session via `practiceSessions.create({ user_practice_id,
         duration_minutes, completed: true, mode_metadata, insight })`,
         shows a toast, refreshes the weekly count, dismisses.
       - **"Save & journal with BotMason"** — calls `onJournal(insight)`,
         which posts the session, awaits the response (so we have the
         `session.id`), then navigates to the Journal screen with
         `{ practice_session_id, mode, durationMinutes, insight }` as nav
         params (the existing journal-link plumbing from
         `phase-3-10-practice-journal-link.md` defines the route name —
         reuse it).
       - **"Skip"** — calls `onSkip()`, which posts the session **without**
         an `insight` and dismisses. Skipping must still log the session;
         analytics matter even when the user doesn't want to write.

2. **Mode summary formatter** — `frontend/src/features/Practice/insights/format.ts`
   - `formatModeSummary(mode, durationMinutes, metadata): string` per mode:
     - meditation_timer: `"{mm:ss} of stillness"`
     - count_up: `"{mm:ss} of open practice"`
     - metronome: `"BPM {bpm_used} for {mm:ss}"`
     - interval_bell: `"{intervals_struck}/{total_intervals} bells over {mm:ss}"`
     - rep_counter: `"{rep_count} {unit_label} in {mm:ss}"` (unit_label
       comes from the parent — pass it through `metadata`).
     - sense_grounding: `"Grounded through {n} senses"`
     - tarot: `"{card_name} for {mm:ss}"`
   - Pure; covered by parameterized tests.

3. **Wire in `PracticeScreen.tsx` (already mounted in ritual-11)**
   - On engine `complete`:
     - Build `modeMetadata` from engine state.
     - Open `InsightCaptureModal` with the metadata + duration.
   - The three callbacks (`onSave`, `onSkip`, `onJournal`) live on the
     screen so they can use the existing API client + nav helpers.
   - Navigation prop name for journal hand-off: re-use whatever
     `phase-3-10` defined; if not implemented yet, gate the
     "Save & journal" button behind a `featureFlag.botmasonHandoff` (read
     from build config) and ship the other two actions; document the
     follow-up.

4. **Tests** — `__tests__/InsightCaptureModal.test.tsx` +
   `insights/format.test.ts`
   - Modal renders the right summary per mode (parameterized).
   - "Save" calls `onSave` with the typed insight.
   - "Save & journal with BotMason" calls `onJournal`.
   - "Skip" calls `onSkip` (no insight).
   - Hard cap at 2,000 chars enforced (validation message shown beyond
     that).
   - `format.test.ts` snapshots the per-mode summary strings.

## Acceptance Criteria

- After every completed session the user is prompted with the modal.
- All three actions log a session; only Skip omits the insight.
- "Save & journal with BotMason" lands the user in Journal with the
  session id attached so BotMason has context.
- Backend POST shape matches ritual-04's accepted payload exactly.
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/components/InsightCaptureModal.tsx` | **Create** |
| `frontend/src/features/Practice/insights/format.ts` | **Create** |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify (wire callbacks; bulk added in ritual-11) |
| `frontend/src/features/Practice/__tests__/InsightCaptureModal.test.tsx` | **Create** |
| `frontend/src/features/Practice/insights/__tests__/format.test.ts` | **Create** |

## If you blow the budget

This issue is small enough that splitting is unlikely. If the journal
hand-off plumbing turns out to require new nav types (likely if
phase-3-10 isn't merged yet), defer "Save & journal" to a follow-up
`12b` and ship the other two actions in `12a` to keep the analytics path
unblocked.
