// Format a millisecond duration as mm:ss for the on-screen timer displays.
// Negative inputs are clamped to 0 so a late tick can never render "-01:23".

import { MS_PER_SECOND, SECONDS_PER_MINUTE } from '../engine/types';

export function formatTime(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const minutes = Math.floor(safe / SECONDS_PER_MINUTE);
  const seconds = safe % SECONDS_PER_MINUTE;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
