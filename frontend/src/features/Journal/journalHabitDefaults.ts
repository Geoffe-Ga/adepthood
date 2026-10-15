import type { Habit, HabitGoalSetup } from '@/features/Habits/Habits.types';

export const JOURNAL_HABIT_DEFAULT_MINUTES = { low: 10, clear: 20, stretch: 45 } as const;
export const JOURNAL_HABIT_DEFAULT_SESSIONS = { low: 1, clear: 1, stretch: 1 } as const;
export const JOURNAL_HABIT_DEFAULT_GOALS: HabitGoalSetup = {
  target_unit: 'minutes',
  frequency: 1,
  frequency_unit: 'per_day',
  ...JOURNAL_HABIT_DEFAULT_MINUTES,
};

/** A local draft has no server writes or usable goal IDs. */
export function writingGoalDraft(habit?: Habit): Habit {
  const base: Habit = habit ?? {
    id: -1,
    name: 'Journaling',
    icon: '✍️',
    stage: 'Beige',
    streak: 0,
    energy_cost: 5,
    energy_return: 5,
    start_date: new Date(),
    goals: [],
    revealed: true,
  };
  const supported =
    base.goals[0]?.target_unit === 'minutes' || base.goals[0]?.target_unit === 'sessions';
  return {
    ...base,
    goals: (['low', 'clear', 'stretch'] as const).map((tier, index) => {
      const existing = base.goals.find((goal) => goal.tier === tier);
      const fallback = {
        id: existing?.id ?? -index - 1,
        title: existing?.title ?? tier,
        tier,
        target: JOURNAL_HABIT_DEFAULT_MINUTES[tier],
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      };
      if (!supported || !existing) return fallback;
      return {
        ...fallback,
        ...existing,
        target_unit: base.goals[0]!.target_unit,
        frequency_unit:
          existing.frequency_unit === 'per_day' || existing.frequency_unit === 'per_week'
            ? existing.frequency_unit
            : 'per_day',
        is_additive: true,
      };
    }),
  };
}

export function writingGoalSetup(habit: Habit): HabitGoalSetup {
  const head = habit.goals[0]!;
  return {
    target_unit: head.target_unit,
    frequency: head.frequency,
    frequency_unit: head.frequency_unit,
    low: habit.goals.find((goal) => goal.tier === 'low')!.target,
    clear: habit.goals.find((goal) => goal.tier === 'clear')!.target,
    stretch: habit.goals.find((goal) => goal.tier === 'stretch')!.target,
  };
}

export function validWritingGoalSetup(setup: HabitGoalSetup): boolean {
  return (
    [setup.low, setup.clear, setup.stretch, setup.frequency].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    setup.low <= setup.clear &&
    setup.clear <= setup.stretch &&
    (setup.target_unit === 'minutes' || setup.target_unit === 'sessions') &&
    (setup.frequency_unit === 'per_day' || setup.frequency_unit === 'per_week')
  );
}
