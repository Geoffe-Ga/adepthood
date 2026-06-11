# phase-8-09: Theme context + dark-mode pilot (Settings + Course reader)

**Labels:** `phase-8`, `frontend`, `ux`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~300

## Problem

`frontend/src/design/tokens.ts:275-310` exports a complete, WCAG-audited
`darkColors` palette (BUG-FE-UI-003) whose docstring promises "component
adoption ships behind a follow-up theme-context PR" — that follow-up never
landed, so the palette has **zero consumers** and every screen hard-binds
the light palette via static `StyleSheet.create(...)` at module load.

A big-bang theme migration would touch every file; the pragmatic first step
is the context + system detection + two pilot surfaces, establishing the
pattern the rest of the app adopts incrementally.

## Scope

`ThemeProvider` with system-preference detection, a `useTheme()` hook
returning the active palette, and adoption in exactly two pilot surfaces:
the Settings screens (`ApiKeySettingsScreen`, `TimezoneSettings`) and the
Course reader (`ChapterReader` + `markdownStyles`). All other screens are
untouched and remain light-palette — no regression risk outside the pilots.

## Tasks

1. **Theme context** (`frontend/src/design/ThemeContext.tsx`)
   - `ThemeProvider` reading `useColorScheme()` (react-native) with an
     explicit override slot for a future in-app toggle; exposes
     `{ colors, isDark }` where `colors` is the light or `darkColors`
     palette merged over shared tokens (spacing/radius unchanged).
   - Mount in `App.tsx` inside the existing provider stack.

2. **Pilot adoption**
   - Convert the two Settings screens and the Course reader from static
     `StyleSheet.create` color usage to theme-driven styles (factory
     function or `useMemo` styles taking the palette).
   - `markdownStyles` becomes a function of the palette so chapter text,
     code blocks, and blockquotes flip with the scheme.

3. **Tests**
   - `useTheme` returns dark palette under a mocked dark `useColorScheme`.
   - One render test per pilot surface asserting a representative
     dark-palette value (e.g. reader body background `#121212`) under the
     dark scheme, and the light value otherwise.

## Acceptance Criteria

- System dark mode flips the two pilot surfaces; all other screens render
  exactly as before (no snapshot churn outside pilots).
- No hardcoded hex values introduced — pilots read palette tokens only.
- Full frontend suite, tsc, eslint green.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/ThemeContext.tsx` | **Create** |
| `frontend/src/App.tsx` | Modify (provider mount) |
| `frontend/src/features/Settings/ApiKeySettingsScreen.tsx` | Modify |
| `frontend/src/features/Course/ChapterReader.tsx` + `Course.styles.ts` | Modify |
| `frontend/src/design/__tests__/ThemeContext.test.tsx` | **Create** |
