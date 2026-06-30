# design-act2-07: Immersive practice player + completion celebration

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 02 (showcase), 03 (celebration), 06 (warm Practice chrome)
**Estimated LoC:** ~240

## Problem

The in-session player views (`MeditationTimerView.tsx`, `IntervalBellView.tsx`,
and the other mode views under `Practice/views/`) are already *immersive in
layout* (a dominant primary display + controls), but they render on the **light
grey** ground, so a meditation session looks like a settings form. And the
session's emotional arc has two flat spots (`a3bf2f34` survey):

- **Completion is silent.** The engine reaches `complete` and the controls bar
  just shows "Practice complete" in `colors.success`
  (`RitualControlsBar.tsx:40`) — no celebratory beat for finishing a sit.
- **The hand-off jolts.** The `InsightCaptureModal` pops abruptly over the
  immersive view (`ActiveRitualSession.tsx:162`), snapping the user out of the
  contemplative state into a form.

## Scope

Make the running session feel like a calm, focused container and give completion
a gentle celebration that flows into reflection. Reuse the existing engine, mode
dispatch, keep-awake, and session-save wiring (`ActiveRitualSession.tsx`); change
the **surface + transitions only**. No new modes, no engine changes.

## Tasks

### 1. Immersive running surface

- When `status === 'running'`, render the active mode view inside a **showcase**
  container (`showcase.surface`), with the primary display (timer ring, bell
  countdown, rep counter) in `onShowcase.primary` and secondary cues in
  `onShowcase.soft`. The dark, candle-lit ground focuses attention; controls use
  the on-dark button treatment. Keep each mode view's existing layout/testIDs —
  only the colour context changes (pass a `tone="showcase"` style set, or wrap).
- Ensure the SVG ring / cue colours read AA on the umber ground (use
  `onShowcase.*` / `accent`).

### 2. Completion celebration

- On `running → complete`, play the shared `Celebration` beat (issue 03): a quiet
  pulse + a serif "Session complete" line on the showcase, reduced-motion-safe.
  Keep the existing success state available to tests.

### 3. Gentle reflection hand-off

- Instead of an abrupt modal, fade the showcase to a calmer "reflection" tone and
  present the insight capture **in place** (or as a softly-animated sheet rising
  from the bottom rather than a hard modal). Preserve the three actions (Save /
  Save & journal / Skip), the char caps, and the `/practice-sessions` save +
  optimistic week-count increment exactly (`InsightCaptureModal.tsx`).

## Tasks — tests

- `ActiveRitualSession.test.tsx`: running state renders the mode view on the
  showcase ground (assert `showcase.surface` on the container); `complete` fires
  the `Celebration`; the insight capture still saves a session and increments the
  week count (existing wiring assertions preserved).
- A reduced-motion test: completion shows the static "complete" line, no
  animation.
- Existing per-mode view tests still pass (layout/testIDs unchanged).

## Acceptance Criteria

- A running session renders on the warm-dark showcase ground with AA-clearing
  cues; controls remain fully usable (44 dp).
- Completing a session plays a reduced-motion-safe celebration and hands off to
  reflection without a jarring modal jump; save/skip/journal wiring unchanged.
- No engine/mode/testID regressions; `cd frontend && npm test && npm run lint &&
  npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify — showcase + celebration + hand-off |
| `frontend/src/features/Practice/components/RitualControlsBar.tsx` | Modify — on-showcase controls |
| `frontend/src/features/Practice/components/InsightCaptureModal.tsx` | Modify — softer rising sheet |
| `frontend/src/features/Practice/views/*` | Modify — accept a showcase tone (colour context only) |
| `frontend/src/features/Practice/**/__tests__/*.test.tsx` | Modify |
