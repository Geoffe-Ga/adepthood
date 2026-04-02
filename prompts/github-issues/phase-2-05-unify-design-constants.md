# phase-2-05: Unify color and spacing constants into a single design system

**Labels:** `phase-2`, `frontend`, `refactor`, `priority-medium`
**Epic:** Phase 2 — Decompose the Monolith
**Estimated LoC:** ~200–250

## Problem

Colors and spacing are defined in at least 5 different places with no single source of truth:

| Location | What's defined | Used by |
|----------|---------------|---------|
| `src/styles/colors.ts` | Empty file | Nothing |
| `src/styles/theme.ts` | Unknown (need to check) | Unknown |
| `src/constants/stageColors.ts` | `STAGE_COLORS` mapping | `HabitUtils.ts` |
| `src/features/Habits/Habits.styles.ts:7-37` | `COLORS` object + `SPACING` + `BORDER_RADIUS` + `SHADOWS` | Habits feature |
| `src/features/Map/stageData.ts:26-37` | `COLORS` array (10 hex values) | Map feature |
| `Sources/design/DesignSystem.ts` | `spacing()`, `breakpoints`, `radius`, `elevation` | HabitsScreen, some components |
| `Sources/design/useResponsive.ts` | `columns`, `gridGutter`, `scale` | HabitsScreen |
| `src/features/Habits/HabitUtils.ts:34-44` | `getTierColor()` — hardcoded hex values | Goal tier display |

The Map's `COLORS` array and `stageColors.ts` define completely different color values for the same stages. `DesignSystem.ts` defines `spacing()` but `Habits.styles.ts` defines its own `SPACING` object. There's no theme provider, making dark mode impossible.

## Scope

Consolidate all design tokens into a single system and eliminate duplicates.

## Tasks

1. **Establish `frontend/src/design/tokens.ts` as the single source of truth**
   - Export `colors`: all app colors including stage colors, tier colors, UI chrome colors
   - Export `spacing`: the spacing scale (use `DesignSystem.ts`'s `spacing()` function as the base)
   - Export `radius`: border radius values
   - Export `shadows`: elevation/shadow values
   - Export `typography`: font sizes and weights (currently scattered as magic numbers)

2. **Merge stage color definitions**
   - `stageColors.ts` and `stageData.ts:COLORS` must agree
   - Create a single `STAGE_COLORS` map in `tokens.ts`
   - Update `HabitUtils.ts:getProgressBarColor()` and `stageData.ts` to import from there

3. **Merge tier color definitions**
   - `HabitUtils.ts:getTierColor()` has hardcoded hex values (`#bc845d`, `#807f66`, `#b0ae91`)
   - Move to `tokens.ts` as `colors.tier.low`, `colors.tier.clear`, `colors.tier.stretch`

4. **Delete duplicate definitions**
   - Remove `COLORS`, `SPACING`, `BORDER_RADIUS`, `SHADOWS` from `Habits.styles.ts` — import from tokens
   - Remove `COLORS` array from `stageData.ts` — import from tokens
   - Delete empty `src/styles/colors.ts`

5. **Relocate `Sources/design/` to `src/design/`**
   - The `Sources/` directory is outside the `src/` tree, which is unusual for a React Native project
   - Move `DesignSystem.ts` and `useResponsive.ts` to `src/design/`
   - Update all import paths

6. **Optional: Add a ThemeProvider wrapper**
   - Create `src/design/ThemeContext.tsx` with a `useTheme()` hook
   - For now, only light mode — but the structure enables dark mode later
   - Components access colors via `useTheme().colors.background` instead of importing constants directly

## Acceptance Criteria

- One file (`tokens.ts`) defines all design tokens
- No duplicate color or spacing definitions
- Stage colors are consistent between Map and Habits
- `Sources/design/` moved into `src/design/`
- All imports updated and tests passing

## Files to Create/Modify/Delete

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | **Create** |
| `frontend/src/design/ThemeContext.tsx` | **Create** (optional) |
| `frontend/Sources/design/DesignSystem.ts` | **Move** to `src/design/` |
| `frontend/Sources/design/useResponsive.ts` | **Move** to `src/design/` |
| `frontend/src/constants/stageColors.ts` | **Delete** (merged into tokens) |
| `frontend/src/styles/colors.ts` | **Delete** (empty) |
| `frontend/src/features/Habits/Habits.styles.ts` | Modify (import from tokens) |
| `frontend/src/features/Habits/HabitUtils.ts` | Modify (import tier colors from tokens) |
| `frontend/src/features/Map/stageData.ts` | Modify (import colors from tokens) |
