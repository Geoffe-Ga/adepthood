import type { Habit } from '../Habits.types';

import { registerStoreReset } from '@/store/registry';

interface Operation {
  operationId: string;
  habitId: number;
  dayKey: string;
  prev: Habit[];
}

interface PendingOperation {
  operation: Operation;
  optimistic: boolean;
  order?: number;
}

// Ordering exists only while requests are pending. Quiet timer logs never
// manufacture a completion, a missed day, or a durable queue entry.
const pending = new Map<string, PendingOperation>();
const rollbackBaselines = new WeakMap<Operation, Habit[]>();
let nextOrder = 0;

export function rememberLogUnit(operation: Operation, optimistic: boolean): void {
  if (!pending.has(operation.operationId)) {
    pending.set(operation.operationId, { operation, optimistic });
  }
}

export function enqueueLogUnit(operation: Operation): void {
  const entry = pending.get(operation.operationId);
  if (entry && entry.order === undefined) entry.order = nextOrder++;
}

export function laterOptimisticLogUnits(operation: Operation): ReadonlySet<string> {
  const current = pending.get(operation.operationId);
  return new Set(
    [...pending.values()]
      .filter(
        ({ operation: other, optimistic, order }) =>
          optimistic &&
          other.habitId === operation.habitId &&
          other.dayKey === operation.dayKey &&
          (order === undefined || order > (current?.order ?? -1)),
      )
      .map(({ operation: other }) => other.operationId),
  );
}

export function forgetLogUnit(operation: Operation): void {
  pending.delete(operation.operationId);
}

/** Whole-list rollback snapshots must retain a quiet log confirmed after capture. */
export function rebasePendingLogUnitRollbacks(confirm: (_habits: Habit[]) => Habit[]): void {
  for (const { operation, optimistic } of pending.values()) {
    if (optimistic) {
      rollbackBaselines.set(operation, confirm(rollbackBaselines.get(operation) ?? operation.prev));
    }
  }
}

export function takeLogUnitRollbackBaseline(operation: Operation): Habit[] {
  const baseline = rollbackBaselines.get(operation) ?? operation.prev;
  rollbackBaselines.delete(operation);
  return baseline;
}

export function clearLogUnitRollbackBaseline(operation: Operation): void {
  rollbackBaselines.delete(operation);
}

registerStoreReset(() => pending.clear());
