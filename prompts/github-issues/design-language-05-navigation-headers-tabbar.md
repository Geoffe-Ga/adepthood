# design-language-05: Editorial navigation — headers & bottom tab bar

**Labels:** `frontend`, `design`, `ux`, `priority-medium`
**Epic:** [Adopt a warm-editorial design language app-wide](design-language-warm-editorial-epic.md)
**Estimated LoC:** ~120
**Depends on:** 01 (semantic tokens), 02 (type ramp).

## Problem

The persistent navigation chrome — the bottom tab bar (`BottomTabs.tsx`) and
stack headers (`RootStack.tsx`) — uses default/grey React Navigation styling.
It frames every screen, so while the screens warm up (issues 03–04) the chrome
stays cold, undercutting the cohesive feel.

## Scope

Theme React Navigation to the warm-editorial language: navigation theme colors,
header background/title/tint, and the bottom tab bar (active/inactive tints,
background, label type). Behaviour and routes are unchanged.

## Tasks

1. **Navigation theme:** build a warm `Theme` object (extend RN Navigation's
   `DefaultTheme`) from `surface`/`ink`/`accent` and pass it to the
   `NavigationContainer`. `colors.background` → `surface.canvas`,
   `colors.card` → `surface.raised`, `colors.primary` → `accent.default`,
   `colors.text` → `ink.primary`, `colors.border` → `surface.hairline`.
2. **Stack headers:** warm header background, `ink` title using the type ramp's
   `heading`/`title` role (serif display where appropriate), terracotta
   back/tint.
3. **Bottom tab bar:** `surface.raised` background with a warm hairline top
   border; active tint = `accent.default`, inactive = `ink.muted`; labels use
   the ramp's `label` role; keep icons and `touchTarget.minimum`.
4. Verify active/inactive tints and labels clear AA on the tab-bar ground.

## Acceptance Criteria

- [ ] The bottom tab bar and stack headers render in the warm-editorial
      language; active/inactive states are clearly distinguishable and AA.
- [ ] Navigation is themed via a single warm `Theme` object sourced from tokens;
      no inline hex in navigation files.
- [ ] All navigation behaviour, routes, deep links, and testIDs are unchanged;
      `BottomTabs.test.tsx` and navigation tests pass (extend for new colors).
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/navigation/BottomTabs.tsx` | Modify (tab bar styling) |
| `frontend/src/navigation/RootStack.tsx` | Modify (header + theme) |
| `frontend/src/App.tsx` | Modify (pass warm Theme to NavigationContainer) |
| `frontend/src/navigation/__tests__/BottomTabs.test.tsx` | Modify |
