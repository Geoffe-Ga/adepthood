/**
 * The writing timer's view state, derived without rendering anything.
 *
 * Every question the pill asks about the engine — which controls to offer, what
 * the readout says, how a screen reader should hear it — is answered here as a
 * pure function of the engine's public state. Keeping it out of the component
 * is what lets the four statuses and the spoken-duration branches be exercised
 * directly instead of through timer choreography, and it keeps the ticking leaf
 * itself small enough to read.
 */
import type { EngineStatus } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE, MS_PER_SECOND, SECONDS_PER_MINUTE } from '@/features/Practice/engine/types';
import { formatTime } from '@/features/Practice/views/formatTime';

export interface TimerViewInput {
  readonly status: EngineStatus;
  /** The engine's countdown; null for modes that do not count down. */
  readonly remainingMs: number | null;
  /** The length the session is currently set to. */
  readonly minutes: number;
}

export interface TimerView {
  /** The mm:ss face of the countdown. */
  readonly readout: string;
  /** The same fact said aloud, for a screen reader that lands on the readout. */
  readonly readoutA11yLabel: string;
  readonly showPresets: boolean;
  readonly showStart: boolean;
  readonly showPause: boolean;
  readonly showResume: boolean;
  readonly showStop: boolean;
}

/** One unit said in the singular or the plural, as a person would say it. */
function unit(count: number, name: string): string {
  return `${count} ${name}${count === 1 ? '' : 's'}`;
}

/**
 * A duration as speech rather than as a clock face.
 *
 * ``01:30`` is a fine thing to look at and a poor thing to hear, so the spoken
 * form names its units. Seconds are floored to match the readout beside it, and
 * an exhausted countdown says "0 seconds" rather than nothing at all.
 */
export function spokenDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const parts: string[] = [];
  if (minutes > 0) parts.push(unit(minutes, 'minute'));
  if (seconds > 0) parts.push(unit(seconds, 'second'));
  if (parts.length === 0) return unit(0, 'second');
  return parts.join(' ');
}

/** Derive everything the pill renders from the engine's state and the set length. */
export function describeTimer({ status, remainingMs, minutes }: TimerViewInput): TimerView {
  const countdownMs = remainingMs ?? minutes * MS_PER_MINUTE;
  const live = status === 'running' || status === 'paused';
  return {
    readout: formatTime(countdownMs),
    readoutA11yLabel: `${spokenDuration(countdownMs)} left`,
    // The length is settable only at rest: the engine re-derives a running
    // session's total from the live config on every tick, so a mid-session
    // change would silently retarget the countdown it is already running.
    showPresets: status === 'idle',
    showStart: status === 'idle',
    showPause: status === 'running',
    showResume: status === 'paused',
    showStop: live,
  };
}

/**
 * The length a preset choice should settle on, given what the timer is doing.
 *
 * A running session's total is re-derived from the live config on every tick,
 * so changing the length mid-session would retarget the countdown already
 * under way and move the moment it completes. Only a timer at rest accepts a
 * new length. Not rendering the presets mid-session is the cover; this is the
 * guard.
 */
export function nextDurationMinutes(
  status: EngineStatus,
  current: number,
  requested: number,
): number {
  return status === 'idle' ? requested : current;
}
