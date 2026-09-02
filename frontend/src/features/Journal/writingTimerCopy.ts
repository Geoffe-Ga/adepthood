/**
 * Microcopy for the writing timer — an offer on the writing surface, never a
 * target (NORTH-STAR "you choose your depth").
 *
 * The timer is something the writer reaches for, so the copy names lengths and
 * actions and nothing else: no count of sessions, no streak, no praise for
 * finishing and no remark on stopping. A finished session gets one sentence
 * saying what happened and a way to close it.
 * ``WRITING_TIMER_COPY_ENTRIES`` enumerates every user-facing string for the
 * balance-not-altitude sweep.
 */
import { WRITING_DURATION_PRESET_MINUTES } from './writingSession';

/** The accessible name of the floating timer itself. */
export const WRITING_TIMER_A11Y_LABEL = 'Writing timer';

/** Names the preset row for a screen reader arriving at the choices. */
export const WRITING_TIMER_PRESET_GROUP_LABEL = 'How long to write for';

export const WRITING_TIMER_START = 'Start';
export const WRITING_TIMER_START_A11Y = 'Start the writing timer';
export const WRITING_TIMER_PAUSE = 'Pause';
export const WRITING_TIMER_PAUSE_A11Y = 'Pause the writing timer';
export const WRITING_TIMER_RESUME = 'Resume';
export const WRITING_TIMER_RESUME_A11Y = 'Resume the writing timer';
export const WRITING_TIMER_STOP = 'Stop';
/** Stopping keeps the time already written; the label says so, so it is not a discard. */
export const WRITING_TIMER_STOP_A11Y = 'Stop the writing timer and keep the time so far';

/** The dismissal on the finished-session note — the only thing it offers. */
export const WRITING_SESSION_DISMISS = 'Close';
export const WRITING_SESSION_DISMISS_A11Y = 'Close the writing session note';

/** A preset's face label: the length, short enough for a row of four. */
export function writingTimerPresetLabel(minutes: number): string {
  return `${minutes} min`;
}

/** The same preset said in full, since "10 min" reads poorly aloud. */
export function writingTimerPresetA11yLabel(minutes: number): string {
  return `Write for ${minutes} minutes`;
}

/**
 * What a finished session amounts to, in one sentence.
 *
 * A statement, not a congratulation and not an invitation to start another:
 * the writer decides what happens next, and the note's only affordance is
 * closing it.
 */
export function writingSessionSummary(elapsedMinutes: number): string {
  const unit = elapsedMinutes === 1 ? 'minute' : 'minutes';
  return `You wrote for ${elapsedMinutes} ${unit}.`;
}

/** Every user-facing writing-timer string, gathered for the balance-not-altitude sweep. */
export const WRITING_TIMER_COPY_ENTRIES: readonly string[] = [
  WRITING_TIMER_A11Y_LABEL,
  WRITING_TIMER_PRESET_GROUP_LABEL,
  WRITING_TIMER_START,
  WRITING_TIMER_START_A11Y,
  WRITING_TIMER_PAUSE,
  WRITING_TIMER_PAUSE_A11Y,
  WRITING_TIMER_RESUME,
  WRITING_TIMER_RESUME_A11Y,
  WRITING_TIMER_STOP,
  WRITING_TIMER_STOP_A11Y,
  WRITING_SESSION_DISMISS,
  WRITING_SESSION_DISMISS_A11Y,
  ...WRITING_DURATION_PRESET_MINUTES.map(writingTimerPresetLabel),
  ...WRITING_DURATION_PRESET_MINUTES.map(writingTimerPresetA11yLabel),
  ...WRITING_DURATION_PRESET_MINUTES.map(writingSessionSummary),
  writingSessionSummary(1),
];
