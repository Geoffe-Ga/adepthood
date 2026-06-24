# audit-ux-01: Add accessibility labels to Habits screen chrome

**Labels:** `audit-ux`, `frontend`, `accessibility`, `priority-high`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~180  (hard cap 700)

## Problem

The interactive chrome on `HabitsScreen` ships with no accessibility metadata. The overflow-menu toggle (`Habits/HabitsScreen.tsx:167-173`), each overflow `MenuItem` (`:129-144`), the mode bar's Exit button (`:67`), the pagination Prev/Next buttons (`:385-403`), and the energy CTA (`EnergyFooter`/`EnergyCTA`, `:426`) carry zero `accessibilityLabel`/`accessibilityRole`. A screen-reader user lands on an unlabeled `MoreHorizontal` icon and unlabeled "Prev"/"Next" `TouchableOpacity` controls and cannot tell what they do or that they are buttons. Current state: the Journal feature labels every interactive element (audit §10), so this is a **UX correctness / a11y** gap, not a missing feature — the controls work, they are just invisible to assistive tech.

## Scope

**Covers:** Adding `accessibilityRole` and human-readable `accessibilityLabel` (plus `accessibilityState` where a control is disabled or toggled) to the overflow-menu toggle and items, the `ModeBar` Exit button, the `PaginationBar` Prev/Next buttons, and the energy CTA, all in `Habits/HabitsScreen.tsx` and any extracted CTA component it renders.

**Does NOT:** Add an empty state (that is audit-ux-07), change layout/styling, refactor the render tree, or touch `HabitTile` internals (already labeled elsewhere). No copy changes beyond the new labels.

## Tasks

1. **Label the overflow toggle and items** — In `Habits/HabitsScreen.tsx`, give the toggle `TouchableOpacity` (`:167`) `accessibilityRole="button"` and `accessibilityLabel="Habit options menu"`, plus `accessibilityState={{ expanded: menuVisible }}`. Give each `MenuItem` (`:129-144`) a role of `"button"` and label derived from its existing `label` text. TDD: with `@testing-library/react-native`, `getByLabelText('Habit options menu')` resolves, and after pressing it `getByRole('button', { name: 'Quick Log' })` (and the other items) resolve.
2. **Label the mode bar Exit button** — `ModeBar` (`:67`): `accessibilityRole="button"`, `accessibilityLabel="Exit {mode label} mode"`. TDD: rendering with a non-normal mode exposes `getByLabelText(/Exit .* mode/)`.
3. **Label pagination Prev/Next** — `PaginationBar` (`:385-403`): role `"button"`, labels `"Previous page"` / `"Next page"`, and `accessibilityState={{ disabled: !canPrev }}` / `{{ disabled: !canNext }}` mirroring the existing `disabled` prop. TDD: on the first page, `getByLabelText('Previous page')` reports `accessibilityState.disabled === true`.
4. **Label the energy CTA** — The energy CTA rendered by `EnergyFooter` (`:426`): role `"button"`, label describing the action (e.g. `"Set up energy scaffolding"`), and label the archive/dismiss control too. TDD: `getByLabelText('Set up energy scaffolding')` resolves when the CTA is shown.

## Acceptance Criteria

- [ ] Every interactive control listed above resolves via `getByLabelText`/`getByRole('button', { name })` in tests.
- [ ] Disabled and expanded controls expose the matching `accessibilityState`.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (add a11y props to chrome) |
| `frontend/src/features/Habits/__tests__/HabitsScreenA11y.test.tsx` | **Create** |
