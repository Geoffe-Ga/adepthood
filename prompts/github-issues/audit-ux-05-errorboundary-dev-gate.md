# audit-ux-05: Gate FeatureErrorBoundary's raw error message behind `__DEV__`

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-medium`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~90  (hard cap 700)

## Problem

`FeatureErrorBoundary.tsx:108` renders `{this.state.error.message}` directly into the fallback UI in every build, including production. The sibling top-level `ErrorBoundary` gates the same disclosure behind `__DEV__` (it only shows the raw message to developers). A thrown error's `message` can contain internal detail — endpoint paths, stack-derived strings, or library internals — which a production user should never see, and which violates the "no leaked internals" rule. Current state: this is a **UX correctness / error-copy** leak; the boundary already shows a friendly heading and body ("...hit a snag" / "Something went wrong while loading this section"), so the raw message line is purely a developer aid that must not ship to users (audit §8 `components/FeatureErrorBoundary.tsx:108`).

## Scope

**Covers:** Wrapping the raw `error.message` `<Text>` (`:108`) so it only renders when `__DEV__` is true, matching the sibling `ErrorBoundary`'s pattern.

**Does NOT:** Change the friendly heading/body copy (`:104-106`), the retry button, the reset-on-focus behavior, or the top-level `ErrorBoundary`. No change to what gets logged to the (no-op) Sentry hook.

## Tasks

1. **Gate the message** — In `FeatureErrorBoundary.render`, render the `styles.message` `<Text>` only when `__DEV__` (e.g. `{__DEV__ && <Text style={styles.message}>{this.state.error.message}</Text>}`), mirroring the sibling `ErrorBoundary`. Keep the friendly heading/body for all builds. TDD: with `__DEV__` forced `false`, a boundary catching an error whose message is `'secret-internal-detail'` does NOT render that text; with `__DEV__` `true`, it does.
2. **Confirm the friendly copy stands alone** — Verify the heading + body still render in both modes so a production user always sees an explanation and the retry control. TDD: in both `__DEV__` states, `getByText(/hit a snag/)` and the "Try again" control resolve.

## Acceptance Criteria

- [ ] In a production build (`__DEV__ === false`), the raw `error.message` is never rendered.
- [ ] In dev (`__DEV__ === true`), the raw message still renders to aid debugging.
- [ ] The friendly heading, body, and retry control render in both modes.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/components/FeatureErrorBoundary.tsx` | Modify (gate message behind `__DEV__`) |
| `frontend/src/components/__tests__/FeatureErrorBoundary.test.tsx` | **Create** or modify (add gating assertions) |
