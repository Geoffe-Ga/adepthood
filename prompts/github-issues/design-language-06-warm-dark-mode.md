# design-language-06: Warm dark mode to match the light language

**Labels:** `frontend`, `design`, `ux`, `priority-low`
**Epic:** [Adopt a warm-editorial design language app-wide](design-language-warm-editorial-epic.md)
**Estimated LoC:** ~140
**Depends on:** 01–05 (the warm light language must exist first).

## Problem

`darkColors` (`tokens.ts:356-374`) is a **neutral** Material-style dark palette
(`#121212` base, grey text) — it predates the warm language and, if enabled,
would clash with the warm light theme. A contemplative, candlelit app deserves a
**warm** dark mode (deep umber/charcoal grounds, warm off-white ink, terracotta
accent), not cold neutral grey.

## Scope

Re-tone the dark palette to the warm-editorial language as **dark semantic
tokens** that mirror the light `surface`/`ink`/`accent` roles from issue 01, and
wire a theme switch so components resolve tokens by mode. Scope the actual
runtime toggle conservatively — the deliverable is a correct, AA-clean warm dark
token set + the resolution mechanism; full per-screen QA can be a follow-up.

## Tasks

1. **Warm dark semantic tokens:** add dark variants of `surface`/`ink`/`accent`
   (and dark `surfaceShadow`) — deep warm grounds (umber/charcoal, not pure
   `#121212`), warm off-white ink, a terracotta accent that stays legible on
   dark. Every `ink`/`accent` value must clear WCAG AA on its dark ground
   (assert in tests, mirroring the light contrast tests).
2. **Mode resolution:** provide a `useTheme()`/theme-context (or extend the
   existing pattern) so components read `surface`/`ink`/`accent` for the active
   mode instead of importing a fixed object. Default to light; respect
   `Appearance`/system setting if cheap to wire.
3. **Re-tone the journal `paper` dark equivalents** (the tokens file notes
   dark-mode paper values are pending) so the journal joins the warm dark theme.
4. **Navigation + chrome:** ensure the warm `Theme` (issue 05) has a dark
   variant selected by mode.

## Acceptance Criteria

- [ ] A warm dark semantic palette exists (not neutral `#121212`) with dark
      `surface`/`ink`/`accent`/shadow tokens; new tests assert AA on dark
      grounds.
- [ ] Components can resolve tokens by mode via a theme hook/context; switching
      mode reskins surfaces without layout or testID changes.
- [ ] The journal's dark paper equivalents exist and stay AA.
- [ ] Light mode is unchanged and all existing tests pass.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify (warm dark semantic tokens + dark paper) |
| `frontend/src/design/ThemeContext.tsx` | **Create** (or extend) — `useTheme()` by mode |
| `frontend/src/design/__tests__/tokens.test.ts` | Modify (dark contrast tests) |
| `frontend/src/App.tsx` / navigation | Modify (select dark Theme by mode) |
