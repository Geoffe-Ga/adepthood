# design-act2-03: Motion language + editorial empty / loading states

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold tokens) — soft; can start in parallel
**Estimated LoC:** ~240

## Problem

Polish lives in the small moments, and they are inconsistent or absent. The
journal has a thoughtful, reduced-motion-safe motion vocabulary (sheet settle-in,
press-scale, resonance fade — `Journal/motion.ts`, `GetResonanceButton.tsx`), but
it is **local to the journal**. Everywhere else:
- **Empty states are bare text.** Practice ("No practice set for this stage
  yet." `PracticeScreen.tsx:222-237`), Journal shelf ("Your shelf is empty —
  start a page." `JournalShelfScreen.tsx:160-177`), and Course
  (`CourseScreen.tsx`) each hand-roll a centred string with no illustration,
  warmth, or suggested next action.
- **Loading is a raw `ActivityIndicator`** that replaces content wholesale
  (Habits, Practice, Course, Detail) — a jarring flash, no skeleton.
- **Arrivals don't celebrate.** Weekly-goal completion is a silent colour change
  (`WeeklyProgress.tsx:86-87`); stage completion is a static ✓ badge
  (`MapScreen.tsx`); there is no shared "you did it" beat.

## Scope

Ship a shared, reduced-motion-safe **motion + feedback** layer: a small motion
helper, an `EmptyState` component, a `Skeleton` loader, and a `Celebration`
overlay/pulse. Adopt them on **two** reference surfaces (the Practice empty state
and the weekly-goal completion) to prove them; the other screens adopt in their
own issues. No data/flow changes.

## Tasks

### 1. Shared motion helper

New `frontend/src/components/motion/useEntrance.ts` (generalised from
`Journal/motion.ts`): returns an animated style for a fade + small `translateY`
entrance, **fully disabled under `useReducedMotion`**, with a `delay` arg for
staggering lists (codifying the Habits onboarding stagger and the journal sheet
settle). Durations/offsets come from a `motion` token block added to `tokens.ts`
(`{ fast: 90, base: 220, settleY: 6 }`).

### 2. `EmptyState` primitive

New `frontend/src/components/feedback/EmptyState.tsx`:
- A warm, centred state: a glyph/illustration slot, a serif `type().heading`
  line, a `type().body` `ink.soft` sub-line, and an optional primary CTA
  (`Button`). Token-only; AA-clearing.
- Props: `{ icon?; title; body?; ctaLabel?; onPressCta?; testID? }`.

### 3. `Skeleton` loader

New `frontend/src/components/feedback/Skeleton.tsx`: a token-coloured
(`surface.sunken`) rounded placeholder with a slow shimmer that **stops under
reduced motion** (falls back to a static fill). Export a `SkeletonCard` preset
matching the card metrics, for list loading states.

### 4. `Celebration` beat

New `frontend/src/components/feedback/Celebration.tsx`: a brief, reduced-motion-
safe pulse/glow + optional message line (e.g. "Goal reached") that auto-dismisses
after ~2 s. No confetti dependency — a token-driven scale/opacity pulse on the
`accent`/`success` tone. Honours `useReducedMotion` (renders the message
statically, no animation).

### 5. Reference adoptions

- Replace the Practice empty state body (`PracticeScreen.tsx:222-237`) with
  `EmptyState` (keep its CTA → Catalog and its testIDs).
- Wrap the weekly-goal-reached transition (`WeeklyProgress.tsx`) in `Celebration`
  so reaching 4/4 pulses once. Keep the existing success-colour assertion.

## Tasks — tests

- `useEntrance.test.ts`: returns animated style normally; returns a static
  (no-anim) style when `useReducedMotion` is true.
- `EmptyState.test.tsx` / `Skeleton.test.tsx` / `Celebration.test.tsx`: render,
  token grounds, reduced-motion fallbacks, CTA fires.
- Practice + WeeklyProgress tests updated; existing assertions preserved.

## Acceptance Criteria

- A shared motion helper + `EmptyState` + `Skeleton` + `Celebration` exist,
  token-only, AA-clearing, and **all** animation is disabled under reduced motion.
- Practice's empty state and the weekly-goal completion use the shared
  components with no behaviour/testID regressions.
- `motion` tokens are the only source of durations/offsets; no magic numbers.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify — add `motion` block |
| `frontend/src/components/motion/useEntrance.ts` | **Create** |
| `frontend/src/components/feedback/EmptyState.tsx` | **Create** |
| `frontend/src/components/feedback/Skeleton.tsx` | **Create** |
| `frontend/src/components/feedback/Celebration.tsx` | **Create** |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify — adopt `EmptyState` |
| `frontend/src/features/Practice/components/WeeklyProgress.tsx` | Modify — adopt `Celebration` |
| `frontend/src/components/**/__tests__/*.test.tsx` | **Create** |
