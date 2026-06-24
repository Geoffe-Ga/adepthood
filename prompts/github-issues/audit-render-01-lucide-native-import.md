# audit-render-01: Fix lucide-react → lucide-react-native import in HabitsScreen

**Labels:** `audit-render`, `frontend`, `performance`, `priority-critical`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~60  (hard cap 700)

## Problem

`frontend/src/features/Habits/HabitsScreen.tsx:3` imports its icons
(`BarChart2, Check, Lock, MoreHorizontal, Pencil, Plus, Unlock, Zap`) from
`lucide-react`, which is the **DOM/web** icon package, instead of
`lucide-react-native`. Current state (§5.2 render cost, severity **Critical**):
on a real device the Habits top bar / overflow menu / mode bar renders nothing
or crashes, because `lucide-react` returns SVG DOM nodes React Native cannot
mount — the screen only "demos" on web. This is the first item in the audit's
"Top 10 things that most hurt a real user right now" (§2.1).

## Scope

Covers the wrong import in `HabitsScreen.tsx`, a repo-wide sweep for any other
app file importing `lucide-react`, and a guard (test and/or lint rule) so the
mistake cannot silently recur. Does NOT change any icon, layout, size, color, or
behavior — the rendered output on native must become correct while remaining
visually identical to the intended design (`lucide-react-native` exposes the
same icon names and prop API).

## Tasks

1. **Switch the import** — change `HabitsScreen.tsx:3` from `'lucide-react'` to
   `'lucide-react-native'`, keeping the same named icons and props.
2. **Sweep the tree** — search `frontend/src/**` for any other `lucide-react`
   (non-native) import and convert each; confirm `lucide-react-native` is the
   only lucide package in `frontend/package.json`.
3. **Add a guard test** — in `frontend/src/features/Habits/__tests__/` (or a
   shared lint guard), assert no app source file imports `lucide-react`. A
   TDD-able test can scan `frontend/src/**/*.{ts,tsx}` and fail on a
   `from 'lucide-react'` (not `-native`) match. Optionally back this with an
   ESLint `no-restricted-imports` rule for `lucide-react`.
4. **Verify Habits chrome renders** — a render test mounts `HabitsScreen` and
   asserts the overflow-menu / mode-bar icons mount without throwing under the
   native test renderer.

## Acceptance Criteria

- [ ] No app file imports `lucide-react` (only `lucide-react-native`), proven by
      the guard test and/or an ESLint `no-restricted-imports` rule.
- [ ] `HabitsScreen` mounts and its icon chrome renders under
      `@testing-library/react-native` without throwing.
- [ ] Visual output unchanged (snapshot/behavior tests pass; same icons, sizes,
      colors).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (line 3 import) |
| `frontend/src/features/Habits/__tests__/no-lucide-react-dom.test.ts` | Create (guard test) |
| `frontend/.eslintrc*` (or ESLint flat config) | Modify (optional `no-restricted-imports`) |
| Any other app file importing `lucide-react` | Modify (convert import) |
