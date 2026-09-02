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
  /** Time actually spent writing, excluding any paused stretch. */
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
 * of it, and flooring would report nineteen. ``elapsedMs`` travels alongside
 * untouched, so anything that needs the exact duration has it without
 * re-deriving the rounding.
 */
export function toWritingSessionResult({
  plannedMinutes,
  elapsedMs,
}: WritingSessionInput): WritingSessionResult {
  return {
    plannedMinutes,
    elapsedMs,
    elapsedMinutes: Math.round(elapsedMs / MS_PER_MINUTE),
    reachedFullDuration: elapsedMs >= plannedMinutes * MS_PER_MINUTE,
  };
}
