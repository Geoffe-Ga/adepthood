import { practiceHabitAmount } from './habitSessionAmount';

import type { CheckInResult, PracticeSessionCreate, PracticeSessionResponse } from '@/api';
import type { HabitManager, LogUnitContext } from '@/features/Habits/services/habitManager';

/** The timer reservation contract; bind only to the tested shared manager foundation. */
export interface TimerHabitLogService extends Pick<HabitManager, 'prepareLogUnit'> {
  reserveLogUnitContext: (_ctx: LogUnitContext) => void;
  discardLogUnitContext: (_ctx: LogUnitContext) => void;
  reconcileReservedLogUnitContext: (_ctx: LogUnitContext, _result: CheckInResult) => void;
  commitLogUnitContext: (
    _ctx: LogUnitContext,
    _options: {
      viaTimer: boolean;
      isCurrent: () => boolean;
      onCommitted: (_result: CheckInResult) => void;
    },
  ) => Promise<CheckInResult | null>;
}
export interface PracticeHabitLogInput {
  session: PracticeSessionResponse;
  payload: PracticeSessionCreate;
  /** Resolve a currently eligible server-backed timer habit before calling. */
  habit: { id: number; name: string; unit: 'minutes' | 'sessions' };
  timezone: string;
  viaTimer?: boolean;
  isCurrent: () => boolean;
  isOwnerCurrent: () => boolean;
  onNotice: (_message: string) => void;
  manager: TimerHabitLogService;
}

function prepare(input: PracticeHabitLogInput): LogUnitContext | null {
  const { session, payload, habit, manager } = input;
  if (!input.isCurrent() || !session.completed || !payload.completed) return null;
  if (session.id <= 0 || session.user_practice_id !== payload.user_practice_id) return null;
  const elapsed = Date.parse(payload.ended_at) - Date.parse(payload.started_at);
  const amount = practiceHabitAmount(habit.unit, elapsed);
  if (amount === null) return null;
  const ctx = manager.prepareLogUnit(habit.id, amount, input.timezone, new Date(payload.ended_at));
  if (!ctx || ctx.serverGoalId === null || ctx.isDemoSeed) return null;
  return ctx;
}
function successNotice(input: PracticeHabitLogInput, amount: number): string {
  if (input.habit.unit === 'sessions') return `Logged a session to ${input.habit.name}`;
  return `Logged ${amount} ${amount === 1 ? 'minute' : 'minutes'} to ${input.habit.name}`;
}

/** Practice persistence is already complete. Only a confirmed habit response can announce a log. */
export async function logCompletedPracticeHabit(
  input: PracticeHabitLogInput,
): Promise<'ignored' | 'logged' | 'failed'> {
  const ctx = prepare(input);
  if (!ctx) return 'ignored';
  const { manager } = input;
  manager.reserveLogUnitContext(ctx);
  let result: CheckInResult | null;
  try {
    result = await manager.commitLogUnitContext(ctx, {
      viaTimer: input.viaTimer ?? true,
      isCurrent: input.isCurrent,
      onCommitted: (confirmed) => {
        if (input.isOwnerCurrent()) manager.reconcileReservedLogUnitContext(ctx, confirmed);
      },
    });
  } catch {
    console.warn('Could not log the completed practice to its linked habit.');
    if (input.isCurrent()) input.onNotice(`Couldn't log to ${input.habit.name}`);
    return 'failed';
  } finally {
    manager.discardLogUnitContext(ctx);
  }
  if (!result) return 'ignored';
  if (input.isCurrent()) input.onNotice(successNotice(input, ctx.amount));
  return 'logged';
}
