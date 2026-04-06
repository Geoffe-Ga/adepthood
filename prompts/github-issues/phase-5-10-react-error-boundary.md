# phase-5-10: Add React error boundary and unified error handling

**Labels:** `phase-5`, `frontend`, `resilience`, `priority-medium`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~200

## Problem

The frontend has no React error boundary. If any component throws during
rendering — a common scenario with malformed API responses, null pointer
access on optional fields, or third-party library errors — the entire app
crashes with a white screen. Each screen handles errors independently with
`try/catch` in hooks, but uncaught render-time errors are not handled.

Additionally, error handling is inconsistent across screens:
- HabitsScreen shows an `ErrorBanner` with retry
- PracticeScreen shows an `ErrorView` component
- JournalScreen silently logs to `console.error`
- MapScreen shows `MapError` text
- CourseScreen silently catches and sets empty state

## Scope

Add a top-level error boundary component and a reusable error fallback. Does
NOT refactor individual screen error handling (that can be standardized later).

## Tasks

1. **Create ErrorBoundary component**
   - `frontend/src/components/ErrorBoundary.tsx`
   - Class component implementing `componentDidCatch` and `getDerivedStateFromError`
   - Renders a fallback UI with error message and "Try Again" button
   - "Try Again" resets the error state and re-renders children
   - Logs error details for debugging (structured, not just console.error)

2. **Create ErrorFallback component**
   - `frontend/src/components/ErrorFallback.tsx`
   - Reusable presentational component showing error icon, message, and retry
   - Accepts `onRetry` and optional `message` props
   - Uses design tokens for consistent styling

3. **Wrap the app in ErrorBoundary**
   - In `App.tsx`, wrap the navigation container with `<ErrorBoundary>`
   - Optionally add per-tab error boundaries around each screen stack

4. **Tests**
   - Test ErrorBoundary catches render errors and shows fallback
   - Test retry button resets error state
   - Test ErrorFallback renders message and calls onRetry

## Acceptance Criteria

- A component throw during render shows a user-friendly error screen, not a crash
- The "Try Again" button re-mounts the failed component tree
- Error details are logged with component stack information
- The error boundary does NOT catch errors inside event handlers (React limitation)
- Tests verify boundary behavior with a deliberately-failing child component
- No existing code or tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/components/ErrorBoundary.tsx` | **Create** |
| `frontend/src/components/ErrorFallback.tsx` | **Create** |
| `frontend/src/App.tsx` | Modify (wrap with ErrorBoundary) |
| `frontend/src/components/__tests__/ErrorBoundary.test.tsx` | **Create** |
