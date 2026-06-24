# audit-testq-04: Fix the hollow snapshot assertion

**Labels:** `audit-testq`, `frontend`, `testing`, `priority-medium`
**Epic:** Test Quality & Green Baseline
**Estimated LoC:** ~60  (hard cap 700)

## Problem

`frontend/src/features/Habits/components/__tests__/OnboardingModal.step2.test.tsx:50`
— the test `renders compact habit tiles` — uses
`expect(tile.props.style).toMatchSnapshot()` as its **sole** assertion.
**Current state:** §5.4 "hollow snapshot" (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:151`).
A snapshot of a style object pins nothing intentional: it passes on first run,
then any later style change is "fixed" by re-recording the snapshot, so it
guards no specific layout property and survives mutations to the styling intent.
The sibling test at line 53 (`applies mystical slider styling`) shows the right
pattern — it asserts exact token values (`COLORS.secondary`) and behavioral
props (`animateTransitions === true`).

## Scope

**Covers:** replacing the `toMatchSnapshot()` call with one or more behavioral
assertions on the actual styling intent of the compact "energy tile" (the
specific layout/visual properties the test name promises — "compact"), and
deleting the now-orphaned snapshot file.

**Does NOT cover:** restyling the component; changing other tests in the file
(lines 39-45, 53-59 already assert real values); a broad sweep of other snapshot
tests in the repo (out of scope for this issue).

## Tasks

1. **Determine the styling intent** — read `OnboardingModal`'s `energy-tile-0`
   style to identify the concrete properties that make the tile "compact"
   (e.g. a specific `width`/`height`/`padding`/`flexBasis`, or a design-token
   color), so the assertion pins a real, named value rather than the whole blob.
2. **Replace the assertion** — in
   `frontend/src/features/Habits/components/__tests__/OnboardingModal.step2.test.tsx`,
   swap `expect(tile.props.style).toMatchSnapshot()` for explicit assertions on
   the flattened style, e.g. assert the exact compact dimension/spacing value(s)
   (use `StyleSheet.flatten(tile.props.style)` so array styles resolve), mirroring
   the value-asserting pattern already used at lines 53-59.
3. **Delete the orphaned snapshot** — remove the stale
   `__tests__/__snapshots__/OnboardingModal.step2.test.tsx.snap` entry/file for
   this test so no dead snapshot lingers.

## Acceptance Criteria

- [ ] The `renders compact habit tiles` test asserts at least one exact,
      named style value (dimension, spacing, or token color), not a snapshot —
      verifiable by locally changing that style value and watching the test go
      red.
- [ ] No `toMatchSnapshot()` remains in the file, and the orphaned `.snap`
      entry is deleted.
- [ ] `cd frontend && npm test` passes; frontend coverage is not reduced.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|---|---|
| `frontend/src/features/Habits/components/__tests__/OnboardingModal.step2.test.tsx` | Modify — replace the snapshot assertion with behavioral style assertions |
| `frontend/src/features/Habits/components/__tests__/__snapshots__/OnboardingModal.step2.test.tsx.snap` | Delete — remove the orphaned snapshot (if present) |
