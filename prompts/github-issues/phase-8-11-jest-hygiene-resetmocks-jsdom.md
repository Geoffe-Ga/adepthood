# phase-8-11: Jest hygiene — enable resetMocks, opt component suites into jsdom

**Labels:** `phase-8`, `frontend`, `tests`, `priority-lower`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~200 (config + per-suite fixes)

## Problem

`frontend/jest.config.js` documents two deliberately deferred test-infra
fixes:

1. **BUG-FE-TEST-001** (lines ~12-20): `clearMocks: true` shipped, but
   `resetMocks: true` — which also restores implementations between tests —
   was deferred because "~90 tests quietly depend on a module-level mock
   implementation surviving across `it()` blocks". That dependence is
   itself the hazard: this session's PR #450 review caught a test passing
   through the *wrong code path* precisely because mock state semantics
   were looser than they looked.
2. **BUG-FE-TEST-002** (lines ~21-26): `testEnvironment: 'node'` is wrong
   for component tests touching `window`/`document`; the deferred fix is
   per-file `@jest-environment jsdom` docblocks rather than a global flip.

## Scope

Flip `resetMocks: true` and repair every suite that breaks (re-establishing
implementations in `beforeEach` rather than relying on survival); add
jsdom docblocks to the component suites that need browser globals. No
production code changes.

## Tasks

1. **resetMocks audit**
   - Set `resetMocks: true`; run the suite; for each failure, move the
     mock implementation into `beforeEach` (the pattern most suites —
     e.g. `useHabitActions.test.tsx` — already follow).
   - Delete the BUG-FE-TEST-001 deferral comment once enabled.

2. **jsdom opt-ins**
   - Identify suites referencing `window`/`document`/`localStorage`
     (grep), add `/** @jest-environment jsdom */` docblocks, and verify
     they pass; delete the BUG-FE-TEST-002 deferral comment.

3. **Guard against regressions**
   - Confirm the suite passes under `TZ=America/New_York` too (the #406
     hermeticity pin must survive the config edits).

## Acceptance Criteria

- `resetMocks: true` in `jest.config.js`; full suite green.
- No test relies on a mock implementation outliving its `it()` block.
- Component suites touching browser globals run under jsdom via docblock.
- Suite remains green under a non-UTC `TZ`.
- No existing tests break (beyond the intentional repairs).

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/jest.config.js` | Modify |
| Affected `__tests__` suites (mock re-establishment, docblocks) | Modify |
