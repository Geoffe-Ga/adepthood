/**
 * The writing timer's contract — what one timed writing session amounts to.
 *
 * Lives in its own module, apart from any component, because more than one
 * surface consumes it: the timer produces a result, the surface decides what
 * to say about it, and the offers that hang off a finished session read it
 * without importing a screen. Nothing here renders, holds state, or persists;
 * it is a shape and one pure function over it.
 *
 * The result is entirely DERIVED from what the engine already froze. The
 * engine lands a session on ``complete`` whether the countdown reached zero or
 * the writer stopped it early, so "did this reach the full duration?" cannot be
 * read off the status — but it can be read off ``elapsedMs`` against the length
 * that was asked for, and a derived answer has no latch to leave stale across a
 * second session in the same mount.
 */
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

/** The length a writing session is offered at when the writer names none. */
export const DEFAULT_WRITING_MINUTES = 20;

/** The lengths the writer can choose between before a session starts. */
export const WRITING_DURATION_PRESET_MINUTES = [10, 20, 30, 45] as const;

/** What the writer asked for, and what actually happened. */
export interface WritingSessionResult {
  /** The length the session was set to, in minutes. */
  readonly plannedMinutes: number;
  /**
   * Time spent writing: paused stretches excluded, bounded by the session
   * length, floored at zero. Never exceeds ``plannedMinutes`` in milliseconds.
   */
  readonly elapsedMs: number;
  /** ``elapsedMs`` to the nearest minute — what a person would call it. */
  readonly elapsedMinutes: number;
  /** Whether the session ran the whole length it was set to. */
  readonly reachedFullDuration: boolean;
}

/** What the engine hands over when a session ends, either way it ends. */
export interface WritingSessionInput {
  readonly plannedMinutes: number;
  readonly elapsedMs: number;
}

/**
 * Turn a finished session's raw elapsed time into the reported result.
 *
 * Minutes round to nearest rather than down, because a writer who stops at
 * 19:59 of twenty spent twenty minutes writing by any account they would give
 * of it, and flooring would report nineteen.
 *
 * The reported duration is BOUNDED by the length the session was set to, and
 * floored at zero. The engine derives elapsed from the wall clock, and a
 * backgrounded app fires no tick — so the first tick after the device wakes
 * observes the entire gap at once, and an unbounded reading hands a
 * twenty-minute session three hours of "writing" nobody did. A session cannot
 * have run for longer than it was set to run for, so the bound is the honest
 * number rather than a cosmetic cap, and it is applied here, in the contract,
 * so every consumer of a session gets the same answer instead of each
 * re-deriving its own.
 *
 * ``reachedFullDuration`` is deliberately decided BEFORE the bound, from the
 * raw reading: if the clock really did pass the full duration then it was
 * reached, and saying otherwise would be a second lie correcting the first.
 * The bound cannot change that answer either way, since clamping downward to
 * exactly the planned length preserves ``>=``.
 */
export function toWritingSessionResult({
  plannedMinutes,
  elapsedMs,
}: WritingSessionInput): WritingSessionResult {
  const plannedMs = plannedMinutes * MS_PER_MINUTE;
  const reachedFullDuration = elapsedMs >= plannedMs;
  const spentMs = Math.min(Math.max(elapsedMs, 0), plannedMs);
  return {
    plannedMinutes,
    elapsedMs: spentMs,
    elapsedMinutes: Math.round(spentMs / MS_PER_MINUTE),
    reachedFullDuration,
  };
}
