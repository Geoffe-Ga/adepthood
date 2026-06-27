# journal-resonance-12: "Get Resonance" floating button + `useIdle`

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-09](journal-resonance-09-editorial-tokens.md)
**Estimated LoC:** ~200

## Role

You are a React Native engineer building the friendly, idle-aware affordance that
invites the user to ask the AI for resonance.

## Goal

Build a `useIdle` hook and a `GetResonanceButton` that **floats into view when
the user stops typing** for a short while and **gently hides while they type**.
It should feel warm and unobtrusive — a soft fade/slide, not a hard toggle. This
issue ships the hook + presentational button + animation; the actual request is
wired in issue 13.

## Context

- Tokens from issue 09 (paper palette, editorial type, shadows for the floating
  affordance).
- Issue 11's screen exposes a typing/idle signal (the current body + last
  keystroke time). If that signal isn't ergonomic, this `useIdle` hook is the
  canonical source and the screen feeds it keystroke timestamps.

## Tasks

1. **`frontend/src/features/Journal/useIdle.ts`**:
   - `useIdle({ delayMs = 1800 }) → { isIdle: boolean; bump: () => void }`.
   - `bump()` is called on each keystroke; `isIdle` flips true after `delayMs`
     with no bump and false immediately on bump. Clean up timers on unmount.
2. **`frontend/src/features/Journal/GetResonanceButton.tsx`** (presentational):
   - Props: `{ visible: boolean; loading?: boolean; disabled?: boolean;
     onPress: () => void }`.
   - Floats (absolute, bottom-center or bottom-right) above the page with a soft
     shadow; label like "Get Resonance" with a small warm glyph.
   - Animate opacity + translateY on `visible` change (`Animated`/Reanimated as
     already used in the app). When `loading`, show a gentle in-progress state
     ("Listening…") and disable taps.
   - Honors `touchTarget.minimum`; accessible label + role.
3. **Visibility rule helper** — a tiny pure fn
   `shouldShowResonance({ isIdle, hasContent, isLoading })` so the rule is unit
   testable (show when idle, there's body content, and not mid-request).
4. **Tests** — `frontend/src/features/Journal/__tests__/GetResonanceButton.test.tsx`
   and `useIdle.test.ts` (fake timers):
   - `useIdle` flips to idle after the delay and resets on `bump`.
   - `shouldShowResonance` truth table.
   - Button calls `onPress`; in `loading` it’s disabled and shows the busy label.
   - Hidden state is not pressable / not focusable.

## Acceptance Criteria

- [ ] Button appears on idle and hides on typing via `useIdle`, with a soft
      animated transition.
- [ ] Loading state disables interaction and reads as friendly, not error-like.
- [ ] Visibility logic is a tested pure function.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/useIdle.ts` | **Create** |
| `frontend/src/features/Journal/GetResonanceButton.tsx` | **Create** |
| `frontend/src/features/Journal/__tests__/useIdle.test.ts` | **Create** |
| `frontend/src/features/Journal/__tests__/GetResonanceButton.test.tsx` | **Create** |

## Constraints

- Presentational + hook only — no API calls here (issue 13 wires the request).
- Animation must respect reduce-motion if the app already honors it elsewhere.
- Tokens only; no magic numbers for timing/size (name the idle delay constant).
