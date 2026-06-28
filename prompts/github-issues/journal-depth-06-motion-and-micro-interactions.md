# journal-depth-06: Add depth-reinforcing motion (reduced-motion safe)

**Labels:** `frontend`, `ux`, `design`, `a11y`
**Epic:** [Give the Journal a floating-page depth & editorial polish](journal-depth-epic.md)
**Depends on:** [journal-depth-02](journal-depth-02-floating-writing-sheet.md), [journal-depth-04](journal-depth-04-lift-marginalia-notes.md), [journal-depth-05](journal-depth-05-floating-shelf-cards.md)
**Estimated LoC:** ~140

## Problem

Static depth (shadows, layering) is convincing, but a little motion makes a
floated surface feel *physical*: a sheet that settles in as it appears, cards
that press down slightly when tapped. The `GetResonanceButton` already
demonstrates the house motion idiom — `Animated` with `useNativeDriver: true`,
short durations, subtle slide (`GetResonanceButton.tsx:56-75`). This issue
extends that idiom to the new floated surfaces — **and gates all of it behind
"Reduce Motion"** so the polish never costs accessibility.

## Scope

Add subtle, tasteful, reduced-motion-aware motion to the floated journal
surfaces. Keep every animation short (<= ~250ms), native-driven, and skippable.
No layout or behaviour changes when motion is disabled.

## Tasks

### 1. A reusable reduced-motion hook

Add `frontend/src/hooks/useReducedMotion.ts` (check first whether one already
exists — there is a `useIdle` hook in `frontend/src/hooks/`; follow its style):

```ts
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** True when the OS "Reduce Motion" setting is on; updates live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (active) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
```

Unit-test it by mocking `AccessibilityInfo`.

### 2. Sheet "settle in" on mount (writing page)

In `JournalEntryScreen.tsx`, when the sheet (issue 02) mounts, fade + lift it a
few px into place (`opacity 0→1`, `translateY 6→0`, ~220ms,
`useNativeDriver: true`). When `useReducedMotion()` is true, start at the final
values and run no animation. Use a token for the slide distance (reuse the
`SLIDE_DISTANCE` idiom from `GetResonanceButton`, or add a small motion token).

### 3. Press feedback on cards (shelf + margin notes)

For shelf entry cards (`JournalShelfScreen.tsx`) and `MarginNote`, add a subtle
press-in: scale to ~0.98 and/or reduce shadow on `pressIn`, restore on
`pressOut`. `TouchableOpacity` already gives an opacity dip; layer a small
`Animated` scale for a "press down into the desk" feel. Skip entirely under
reduced motion (fall back to the default opacity press).

Keep hit areas >= `touchTarget.minimum`; the scale is visual only and must not
shrink the touch target.

### 4. Respect reduced motion everywhere

Every animation added here must check `useReducedMotion()` and, when true,
render the final state with no transition. Add a test asserting that with
reduce-motion mocked **on**, the animated value is at its resting value
immediately (no in-flight interpolation).

## Tasks — tests

- `useReducedMotion` test: returns the mocked initial value and updates on the
  `reduceMotionChanged` event.
- Sheet mount: with reduced motion **off**, the sheet's animated style starts
  below final and settles; with it **on**, it renders at final immediately.
- Card press: `pressIn`/`pressOut` adjust the animated scale when motion is on;
  no-op when off. Use fake timers + `act` consistent with the existing suite.

## Acceptance Criteria

- The writing sheet gently settles in on mount; shelf cards and margin notes
  give subtle press feedback — all short, native-driven, and tasteful.
- With OS "Reduce Motion" enabled, **no** journal animation runs; surfaces
  render directly at their resting state with identical layout.
- Touch targets remain >= 44dp; no behaviour or navigation changes.
- New tests cover both the motion-on and motion-off paths; coverage stays at
  thresholds.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/hooks/useReducedMotion.ts` | Create (if absent) — reduced-motion hook |
| `frontend/src/hooks/__tests__/useReducedMotion.test.ts` | Create — hook tests |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify — sheet settle-in |
| `frontend/src/features/Journal/MarginNote.tsx` | Modify — press feedback |
| `frontend/src/features/Journal/JournalShelfScreen.tsx` | Modify — card press feedback |
| `frontend/src/features/Journal/__tests__/*` | Modify — motion on/off assertions |
</content>
