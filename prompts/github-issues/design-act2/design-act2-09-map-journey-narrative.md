# design-act2-09: Map — a journey narrative with achievement

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 02 (showcase), 03 (celebration)
**Estimated LoC:** ~260

## Problem

The Map is the app's most visually invested surface — a custom three-column
"spiral of becoming" with per-stage colours tuned to artwork, mystical glows, a
serif title, and a rich stage-detail modal (`a308cecd` survey). But its **journey
narrative** is weak, so a beautiful canvas reads as static:

- No sense of momentum: completed stages get a ✓ badge, the current stage a subtle
  `glowLight` ring, but the eye gets no "you came from here → you are here → next"
  story (`MapScreen.tsx`).
- Locked stages are just opacity 0.4 + 🔒 with no "unlocks in N" timeline
  (`LockOverlay`).
- The detail modal is on a flat dark `colors.secondary` ground disconnected from
  the spiral's colours; its "Your Journey" history is a pile of disparate counts
  (practices / habits / streaks) rather than one progression
  (`StageHistorySection`), and its three action buttons are equal-weight with no
  next-step hierarchy.
- Reaching 100 % on a stage has no celebration.

## Scope

Strengthen the **narrative and achievement** layer over the existing spiral
artwork — do not redraw the spiral or change its geometry. Reconcile the detail
modal with the warm showcase language, add a journey-progress read, add unlock
timelines, give the history one voice, rank the actions, and celebrate stage
completion.

## Tasks

### 1. Current-stage emphasis + journey read

- Strengthen the current-stage marker (brighter accent halo than completed
  stages) and add a quiet "you are here" label so the eye finds the present
  position instantly. Keep the existing hotspot geometry (`stageData.ts`).
- Add a compact journey read near the title — e.g. "Stage 5 of 10 · Week 12" —
  so the spiral states a position, not just a picture.

### 2. Unlock timeline on locked stages

- On a locked stage's overlay (and in its modal), surface "Unlocks in N days" /
  the unlock condition from the program data, replacing the bare 🔒.

### 3. Showcase the detail modal + one-voice history

- Re-ground the stage-detail modal on the **showcase** surface (`onShowcase`
  text), tinted with that stage's colour as an accent rule, so it feels of-a-piece
  with the spiral rather than a generic dark sheet.
- Rewrite "Your Journey" as a single progression sentence + a small set of
  ranked stats (e.g. "12 practices · 3 habits at clear tier · 21-day streak"),
  using the medal palette for tier badges as today, but framed as one story.
- Rank the three actions: a primary **Continue** (the stage's most relevant next
  step) + two secondary links, instead of three equal buttons.

### 4. Stage-completion celebration

- When a stage hits 100 %, play the shared `Celebration` (issue 03) and reveal a
  brief "Stage complete — {next stage} unlocked" beat.

## Tasks — tests

- `MapScreen.test.tsx`: current stage renders the stronger marker + "you are
  here"; a locked stage shows an unlock-timeline string; the detail modal renders
  on the showcase ground with ranked actions (primary Continue + 2 secondary);
  history renders the one-voice summary. Hotspot geometry/tap targets unchanged.
- Completion path fires `Celebration` at 100 %.

## Acceptance Criteria

- The Map states a clear journey position with strong current-stage emphasis and
  unlock timelines on locked stages.
- The detail modal is reconciled to the warm showcase language, the history reads
  as one progression, and actions are ranked (one primary Continue).
- Stage completion celebrates; the spiral artwork/geometry and all existing
  tap/lock/badge behaviour are unchanged.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapScreen.tsx` | Modify — emphasis, journey read, modal, history, actions |
| `frontend/src/features/Map/Map.styles.ts` | Modify — showcase modal, warm tokens for bands |
| `frontend/src/features/Map/__tests__/*.test.tsx` | Modify |
