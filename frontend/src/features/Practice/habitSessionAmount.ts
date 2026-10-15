import { MS_PER_MINUTE } from './engine/types';

/** Count the persisted sitting's active time, rather than its planned length or a daily gap. */
export function practiceHabitAmount(unit: string, elapsedMs: number): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (unit === 'sessions') return 1;
  if (unit === 'minutes') return Math.max(1, Math.round(elapsedMs / MS_PER_MINUTE));
  return null;
}
