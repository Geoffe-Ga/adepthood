// Format a millisecond duration as mm:ss for the on-screen timer displays.
// Negative inputs are clamped to 0 so a late tick can never render "-01:23".

import { MS_PER_MINUTE, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../engine/types';

export function formatTime(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const minutes = Math.floor(safe / SECONDS_PER_MINUTE);
  const seconds = safe % SECONDS_PER_MINUTE;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Which way a spoken session readout counts. */
export type SpokenTimeDirection = 'remaining' | 'elapsed' | 'next';

const SPOKEN_SUFFIX: Record<SpokenTimeDirection, string> = {
  remaining: 'remaining',
  elapsed: 'elapsed',
  next: 'until the next bell',
};

/**
 * A minute-granular screen-reader phrasing of a session readout.
 *
 * The on-screen mm:ss changes every second; announcing it at that rate would
 * drown the practice in chatter, so the accessible label changes at most once
 * a minute. A countdown rounds up ("12 minutes remaining" until the twelfth
 * minute is fully spent); a count-up rounds down.
 */
export function spokenTime(ms: number, direction: SpokenTimeDirection): string {
  const safe = Math.max(0, ms);
  const suffix = SPOKEN_SUFFIX[direction];
  if (safe < MS_PER_MINUTE) {
    return direction === 'elapsed' ? 'Under a minute elapsed' : `Less than a minute ${suffix}`;
  }
  const round = direction === 'elapsed' ? Math.floor : Math.ceil;
  const minutes = round(safe / MS_PER_MINUTE);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ${suffix}`;
}
