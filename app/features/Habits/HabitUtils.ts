import { STAGE_COLORS } from '../../constants/stageColors';

import type { Goal, Habit, Completion } from './Habits.types';

export const STAGE_ORDER = [
  'Beige',
  'Purple',
  'Red',
  'Blue',
  'Orange',
  'Green',
  'Yellow',
  'Turquoise',
  'Ultraviolet',
  'Clear Light',
];

export const getTierColor = (tier: 'low' | 'clear' | 'stretch') => {
  switch (tier) {
    case 'low':
      return '#bc845d';
    case 'clear':
      return '#807f66';
    case 'stretch':
      return '#b0ae91';
    default:
      return '#dad9d4';
  }
};

export const clampPercentage = (value: number): number => Math.min(100, Math.max(0, value));

export const isGoalAchieved = (goal: Goal, habit: Habit): boolean => {
  const totalProgress = calculateHabitProgress(habit);
  const targetValue = getGoalTarget(goal);
  return goal.is_additive ? totalProgress >= targetValue : totalProgress <= targetValue;
};

export const getMarkerPositions = (
  lowGoal?: Goal,
  clearGoal?: Goal,
  stretchGoal?: Goal,
): { low: number; clear: number; stretch: number } => {
  if (!lowGoal) return { low: 0, clear: 0, stretch: 0 };

  if (lowGoal.is_additive) {
    if (clearGoal) {
      const low = clampPercentage((lowGoal.target / clearGoal.target) * 100);
      const clear = 100;
      const stretch = stretchGoal ? 100 : 0;
      return { low, clear, stretch };
    }
    return { low: 100, clear: 0, stretch: 0 };
  }

  const maxTarget = lowGoal.target;
  const minTarget = stretchGoal ? stretchGoal.target : 0;
  const normalize = (v: number) => ((v - minTarget) / (maxTarget - minTarget)) * 100;
  const stretch = 0;
  const clear = clearGoal ? clampPercentage(normalize(clearGoal.target)) : 50;
  const low = 100;
  return { low, clear, stretch };
};

export const calculateProgressIncrements = (goal: Goal): number[] => {
  const { target } = goal;

  if (target <= 5) {
    return Array.from({ length: target }, (_, i) => i + 1);
  } else if (target <= 10) {
    return Array.from({ length: 5 }, (_, i) => ((i + 1) * target) / 5);
  } else if (target <= 100) {
    return Array.from({ length: 5 }, (_, i) => Math.ceil(((i + 1) * target) / 5));
  } else {
    const increment = Math.ceil(target / 5);
    return Array.from({ length: 4 }, (_, i) => (i + 1) * increment);
  }
};

export const getGoalTarget = (goal: Goal): number => {
  if (!goal) return 0;
  if (goal.frequency_unit === 'per_day') {
    return goal.target;
  }
  if (goal.frequency_unit === 'per_week') {
    return (goal.target / 7) * goal.frequency;
  }
  if (goal.frequency_unit === 'per_month') {
    return (goal.target / 30) * goal.frequency;
  }
  return goal.target;
};

export const calculateHabitProgress = (habit: Habit): number => {
  if (!habit.completions || habit.completions.length === 0) {
    return 0;
  }
  return habit.completions.reduce((sum, c) => sum + c.completed_units, 0);
};

export const getGoalTier = (
  habit: Habit,
): {
  currentGoal: Goal;
  nextGoal: Goal | null;
  completedAllGoals: boolean;
} => {
  const sortedGoals = [...habit.goals].sort((a, b) => {
    const tierOrder = { low: 1, clear: 2, stretch: 3 } as const;
    return tierOrder[a.tier] - tierOrder[b.tier];
  }) as [Goal, Goal, Goal];

  const [lowGoal, clearGoal, stretchGoal] = sortedGoals;
  const totalProgress = calculateHabitProgress(habit);
  let currentGoal = lowGoal;
  let nextGoal: Goal | null = null;
  let completedAllGoals = false;

  if (lowGoal.is_additive) {
    if (totalProgress >= getGoalTarget(stretchGoal)) {
      currentGoal = stretchGoal;
      completedAllGoals = true;
    } else if (totalProgress >= getGoalTarget(clearGoal)) {
      currentGoal = clearGoal;
      nextGoal = stretchGoal;
    } else if (totalProgress >= getGoalTarget(lowGoal)) {
      currentGoal = lowGoal;
      nextGoal = clearGoal;
    } else {
      currentGoal = lowGoal;
    }
  } else {
    const lowTarget = getGoalTarget(lowGoal);
    const clearTarget = getGoalTarget(clearGoal);
    const stretchTarget = getGoalTarget(stretchGoal);

    if (totalProgress <= stretchTarget) {
      currentGoal = stretchGoal;
      completedAllGoals = true;
    } else if (totalProgress <= clearTarget) {
      currentGoal = clearGoal;
      nextGoal = stretchGoal;
    } else if (totalProgress <= lowTarget) {
      currentGoal = lowGoal;
      nextGoal = clearGoal;
    } else {
      currentGoal = lowGoal;
    }
  }

  return { currentGoal, nextGoal, completedAllGoals };
};

// Returns current progress as a percentage between 0 and 100.
//
// The calculation supports both additive (e.g. "do X more") and
// subtractive (e.g. "drink X less") habit types. The function also
// ensures progress never overflows beyond the 0-100 range.
export const getProgressPercentage = (
  habit: Habit,
  currentGoal: Goal,
  nextGoal: Goal | null,
): number => {
  const totalProgress = calculateHabitProgress(habit);
  const isAdditive = currentGoal.is_additive;

  if (isAdditive) {
    const currentTarget = getGoalTarget(currentGoal);

    if (nextGoal) {
      const nextTarget = getGoalTarget(nextGoal);

      if (currentGoal.tier === 'clear' && nextGoal.tier === 'stretch') {
        if (totalProgress >= currentTarget) {
          return Math.min(
            100,
            ((totalProgress - currentTarget) / (nextTarget - currentTarget)) * 67 + 33,
          );
        }
      }

      if (currentGoal.tier === 'low' && nextGoal.tier === 'clear') {
        if (totalProgress >= currentTarget) {
          return Math.min(
            100,
            ((totalProgress - currentTarget) / (nextTarget - currentTarget)) * 100,
          );
        }
      }
    }

    return Math.min(100, (totalProgress / currentTarget) * 100);
  } else {
    const lowGoal = habit.goals.find((g) => g.tier === 'low')!;
    const stretchGoal = habit.goals.find((g) => g.tier === 'stretch')!;
    const lowTarget = getGoalTarget(lowGoal);
    const stretchTarget = getGoalTarget(stretchGoal);

    if (totalProgress <= stretchTarget) {
      return 100;
    }
    if (totalProgress >= lowTarget) {
      return 0;
    }

    return 100 - ((totalProgress - stretchTarget) / (lowTarget - stretchTarget)) * 100;
  }
};

export const getProgressBarColor = (habit: Habit): string => {
  return STAGE_COLORS[habit.stage] ?? '#000';
};

// Logs a number of units for the given habit. Multiple logs can occur within
// the same day; however, the streak counter will only increment once per
// calendar day. Returns the updated habit object.
export const logHabitUnits = (habit: Habit, amount: number, date: Date = new Date()): Habit => {
  const alreadyLoggedToday =
    habit.last_completion_date &&
    new Date(habit.last_completion_date).toDateString() === date.toDateString();

  const completion: Completion = {
    id: Math.random(),
    timestamp: date,
    completed_units: amount,
  };

  return {
    ...habit,
    streak: alreadyLoggedToday ? habit.streak : habit.streak + 1,
    last_completion_date: date,
    completions: habit.completions ? [...habit.completions, completion] : [completion],
  };
};
