import { validWritingGoalSetup, writingGoalSetup } from './journalHabitDefaults';
import { canConfigureWritingHabit, isLinkableHabit } from './writingHabitCheckOff';

import { goals, habits, toLocalHabit } from '@/api';
import type { GoalUpdatePayload } from '@/api';
import { captureAuthScope, captureSessionToken, isAuthScopeCurrent } from '@/api/sessionToken';
import type { Goal, Habit, HabitGoalSetup } from '@/features/Habits/Habits.types';
import { isServerIssuedId } from '@/features/Habits/services/serverIds';
import { saveHabits } from '@/storage/habitStorage';
import { parseUserId } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';
import { decodeJwtPayload } from '@/utils/token';

const UNCONFIRMED_GOALS = 'The timer habit goals could not all be confirmed.';

function goalUpdate(goal: Goal, setup: HabitGoalSetup): GoalUpdatePayload {
  return {
    title: goal.title,
    tier: goal.tier,
    target: setup[goal.tier],
    target_unit: setup.target_unit,
    frequency: setup.frequency,
    frequency_unit: setup.frequency_unit,
    is_additive: true,
    goal_group_id: goal.goal_group_id ?? null,
    days_of_week: goal.days_of_week ?? null,
  };
}

function matchesSetup(habit: Habit, setup: HabitGoalSetup): boolean {
  if (!isLinkableHabit(habit)) return false;
  const confirmed = writingGoalSetup(habit);
  return (['target_unit', 'frequency', 'frequency_unit', 'low', 'clear', 'stretch'] as const).every(
    (key) => confirmed[key] === setup[key],
  );
}

async function confirmGoalSetup(
  habitId: number,
  setup: HabitGoalSetup,
  tz: string,
  token: string,
  current: () => boolean,
): Promise<Habit | null> {
  const rows = await habits.listAll(token);
  if (!current()) return null;
  const row = rows.find((candidate) => candidate.id === habitId);
  if (!row) throw new Error(UNCONFIRMED_GOALS);
  const confirmed = toLocalHabit(row, tz);
  if (!matchesSetup(confirmed, setup)) throw new Error(UNCONFIRMED_GOALS);
  // Only the confirmed ladder changes here. A check-in or another habit may
  // have changed while these writes were in flight; preserve that live work.
  const live = useHabitStore.getState().habits;
  const existing = live.find((candidate) => candidate.id === habitId);
  if (!existing) return null;
  const nextHabit = { ...existing, goals: confirmed.goals };
  const next = live.map((candidate) => (candidate.id === habitId ? nextHabit : candidate));
  useHabitStore.getState().setHabits(next);
  await saveHabits(next);
  return current() ? nextHabit : null;
}

function credentialBelongsTo(token: string | undefined, owner: number | null): token is string {
  return (
    owner !== null && token !== undefined && parseUserId(decodeJwtPayload(token)?.sub) === owner
  );
}

/** Pin the save to its account and session: a same-owner re-login ends it too (#3423). */
function captureWritingGoalOwner(token?: string) {
  const scope = captureAuthScope();
  const live = captureSessionToken();
  if (!credentialBelongsTo(live, scope.owner)) return null;
  const credential = token ?? live;
  if (!credentialBelongsTo(credential, scope.owner)) return null;
  return { credential, current: () => isAuthScopeCurrent(scope) };
}

/** Link only after the API confirms every requested unit and target. A partial
 * write remains visible on refresh, but must never be described as a link. */
export async function saveWritingHabitGoals(
  habit: Habit,
  setup: HabitGoalSetup,
  tz: string,
  token?: string,
): Promise<Habit | null> {
  if (!canConfigureWritingHabit(habit) || !validWritingGoalSetup(setup))
    throw new Error(UNCONFIRMED_GOALS);
  const scope = captureWritingGoalOwner(token);
  if (!scope) return null;
  const { credential, current } = scope;
  await habits.updateGoalUnits(
    habit.id,
    {
      target_unit: setup.target_unit,
      frequency: setup.frequency,
      frequency_unit: setup.frequency_unit,
    },
    credential,
  );
  for (const goal of habit.goals) {
    if (!current()) return null;
    if (!isServerIssuedId(goal.id)) throw new Error(UNCONFIRMED_GOALS);
    await goals.update(goal.id, goalUpdate(goal, setup), credential);
  }
  if (!current()) return null;
  return confirmGoalSetup(habit.id, setup, tz, credential, current);
}
