import type { Goal, Habit } from './Habits.types';
import { isHabitUnlocked, isSubtractiveHabit } from './HabitUtils';
import { isServerBackedHabit, isServerIssuedId } from './services/serverIds';

const TIMER_TIERS = ['low', 'clear', 'stretch'] as const;

/** An existing open server habit whose goals can be configured for a timer. */
export function canConfigureTimerHabit(habit: Habit): boolean {
  return (
    isServerBackedHabit(habit) &&
    isHabitUnlocked(habit) &&
    !isSubtractiveHabit(habit) &&
    TIMER_TIERS.every((tier) => habit.goals.some((goal) => goal.tier === tier)) &&
    habit.goals.every((goal) => isServerIssuedId(goal.id))
  );
}

function compatibleTimerGoal(goal: Goal, reference: Goal): boolean {
  const unit = goal.target_unit === 'minutes' || goal.target_unit === 'sessions';
  const cadence = goal.frequency_unit === 'per_day' || goal.frequency_unit === 'per_week';
  return (
    unit &&
    cadence &&
    goal.target_unit === reference.target_unit &&
    goal.frequency_unit === reference.frequency_unit &&
    goal.frequency === reference.frequency &&
    goal.is_additive
  );
}

/** Both timer consumers count the same additive server-owned unit ladder. */
export function isTimerLinkableHabit(habit: Habit): boolean {
  const reference = habit.goals[0];
  return (
    canConfigureTimerHabit(habit) &&
    reference !== undefined &&
    habit.goals.every((goal) => compatibleTimerGoal(goal, reference))
  );
}
