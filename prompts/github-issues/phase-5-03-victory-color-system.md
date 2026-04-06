# phase-5-03: Add victory color system to progress bars

**Labels:** `phase-5`, `frontend`, `ux`, `priority-medium`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~100

## Problem

Two prompts specify visual color feedback on the progress bar that the implementation doesn't have:

From `HabitsPrompt-2025-08-22.md`:
> "Add the victory color and flash an alert that says 'Achieved! Keep going for the Stretch Goal!'"
> "Bar should start off completely full in the color of Victory"
> "As soon as stretch goal is broken for a subtractive goal, the bar becomes its stage's color again"

Currently, `getProgressBarColor()` always returns the stage color regardless of goal state:

```typescript
// HabitUtils.ts:262
export const getProgressBarColor = (habit: Habit): string => {
  return STAGE_COLORS[habit.stage] ?? '#000';
};
```

This means there's no visual distinction between "working toward a goal" and "goal achieved." For subtractive goals especially, the bar is always the stage color — you can't tell at a glance whether you're succeeding (staying under target) or failing (exceeding it). The prompt's two-color system communicates status instantly.

## Scope

Enhance `getProgressBarColor()` to return a victory color (gold/green) when goals are met, and the normal stage color otherwise. Add a brief flash animation when transitioning from stage color → victory color.

## Tasks

### 1. Define the victory color

Add to `frontend/src/design/tokens.ts`:
```typescript
export const VICTORY_COLOR = '#c9a44c'; // Warm gold — celebratory but not garish
```

This should harmonize with the existing tier colors (bronze `#bc845d`, sage `#807f66`, tan `#b0ae91`) while being clearly distinct from all 10 stage colors.

### 2. Update getProgressBarColor()

Refactor to accept the current goal state and return the appropriate color:

```typescript
export const getProgressBarColor = (habit: Habit): string => {
  const { completedAllGoals } = getGoalTier(habit);
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');

  if (!clearGoal) return STAGE_COLORS[habit.stage] ?? '#000';

  const isAdditive = clearGoal.is_additive;
  const progress = calculateHabitProgress(habit);
  const clearTarget = getGoalTarget(clearGoal);

  if (isAdditive) {
    // Victory color when clear goal is met (working toward stretch)
    if (progress >= clearTarget) return VICTORY_COLOR;
  } else {
    // Subtractive: victory color when staying under stretch target
    const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');
    if (stretchGoal && progress <= getGoalTarget(stretchGoal)) {
      return VICTORY_COLOR;
    }
  }

  return STAGE_COLORS[habit.stage] ?? '#000';
};
```

### 3. Add color transition animation in HabitTile

When the bar color changes from stage → victory (or vice versa), animate the transition:
- Use `Animated.timing` with a 400ms duration
- Interpolate between the two colors using `interpolateColor` or opacity crossfade
- This creates the "flash" effect the prompt describes without being jarring

### 4. Subtractive goal: victory color by default

For subtractive goals, the bar should start gold (victory) because the user begins in a "winning" state (zero units logged = under target). The bar transitions to the stage color as soon as the stretch threshold is exceeded.

### 5. Update tests

- Test `getProgressBarColor` returns victory color when clear goal is met (additive)
- Test `getProgressBarColor` returns victory color when under stretch target (subtractive)
- Test `getProgressBarColor` returns stage color when goals are not met
- Test color transition when progress crosses a threshold

## Acceptance Criteria

- Progress bar is gold (`#c9a44c`) when the user has met their clear goal (additive) or is under the stretch target (subtractive)
- Progress bar is the stage color when working toward goals
- Color transitions are animated (400ms), not instant
- Subtractive habits start with the victory color
- Subtractive habits revert to stage color when stretch threshold is broken
- Existing progress percentage calculations are unchanged
- All existing HabitUtils tests continue to pass

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify (add VICTORY_COLOR) |
| `frontend/src/features/Habits/HabitUtils.ts` | Modify (refactor getProgressBarColor) |
| `frontend/src/features/Habits/HabitTile.tsx` | Modify (add color animation) |
| `frontend/src/features/Habits/__tests__/HabitsScreen.test.ts` | Modify (update color tests) |
