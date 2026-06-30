# design-act2-12: Program onboarding / welcome

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold), 02 (showcase/callout), 04 (Today hub — the destination)
**Estimated LoC:** ~280

## Problem

A new user is dropped straight from signup into the app shell (Habits today, the
Today hub after issue 04) with **no welcome into the 36-week APTITUDE journey**
(`a7d95417` survey: no `WelcomeScreen`/`OnboardingScreen` anywhere). Habits has a
rich in-tab `OnboardingModal` for energy-scaffolding, but nothing sets the
contemplative tone of the *program* or explains the five pillars (habits,
practice, course, journal, map) before work begins. The first run is the highest-
intent, highest-impact moment to establish the product's voice — and it is empty.

## Scope

Add a short, skippable first-run **program welcome** that introduces the journey
and the five pillars in the warm editorial language, then lands the user on the
Today hub. Gate it on a persisted "has seen welcome" flag so it shows once. Reuse
the existing Habits `OnboardingModal` for the optional first-habits step rather
than re-implementing it. No backend changes — the flag lives in the existing
AsyncStorage persistence layer.

## Tasks

### 1. The welcome flow

- New `frontend/src/features/Onboarding/WelcomeScreen.tsx`: a 3–4 panel,
  swipeable editorial intro built from `ShowcaseCard` heroes —
  1. A serif welcome to the 36-week path (program voice, `CalloutBand` accent
     moment).
  2. The five pillars, one calm line each (Habits / Practice / Course / Journal /
     Map) with their tab glyphs.
  3. "How a week works" — the rhythm of the program in one screen.
  4. A "Begin" CTA → the Today hub (and optionally open the Habits
     `OnboardingModal` to seed first habits).
- Reduced-motion-safe panel transitions (issue 03 `useEntrance`); a persistent
  **Skip** affordance on every panel.

### 2. First-run gating

- Add a `hasSeenWelcome` flag to the existing persistence layer (AsyncStorage
  store) and a small `useFirstRun()` selector.
- In `App.tsx` (post-auth), route to `WelcomeScreen` when the flag is unset, then
  to the tab shell; set the flag on Begin **or** Skip so it never reappears.
  Preserve the existing auth → tabs flow for returning users (no extra frame for
  someone who has seen it).

## Tasks — tests

- `WelcomeScreen.test.tsx`: panels render; Skip and Begin both set
  `hasSeenWelcome` and navigate to the Today hub; reduced-motion path renders
  static panels.
- `App` / routing test: a fresh (flag-unset) user sees Welcome once; a returning
  (flag-set) user goes straight to the tabs; the flag persists across reloads
  (mock AsyncStorage).
- Existing auth → shell tests unchanged for returning users.

## Acceptance Criteria

- First run after signup shows a skippable, warm editorial welcome that
  introduces the journey and the five pillars, then lands on the Today hub.
- The welcome shows exactly once (persisted flag set on Begin or Skip); returning
  users are unaffected; the optional first-habits step reuses the existing
  `OnboardingModal`.
- No backend changes; reduced-motion-safe; no magic numbers. `cd frontend &&
  npm test && npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Onboarding/WelcomeScreen.tsx` | **Create** |
| `frontend/src/features/Onboarding/useFirstRun.ts` | **Create** |
| `frontend/src/store/` (persistence layer) | Modify — `hasSeenWelcome` flag |
| `frontend/src/App.tsx` | Modify — first-run routing post-auth |
| `frontend/src/features/Onboarding/__tests__/WelcomeScreen.test.tsx` | **Create** |
