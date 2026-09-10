/**
 * Render an accumulated practice total as hours and minutes.
 *
 * Distinct from `formatDuration`, which renders the *length of one sitting*
 * ("10 min") and is right to stay in minutes: a practice is rarely more than an
 * hour long, and "0h 10m" would be noise on a catalog row. A lifetime total is
 * the opposite shape — it passes 60 minutes on the second or third sitting and
 * then never comes back — so it reads in hours with the remainder past 60,
 * which is what issue #2449 asks for.
 *
 * Rounding happens once, on the whole total, before the split. Splitting first
 * and rounding the remainder can print "0h 60m": 59.6 minutes is an hour.
 */

const MINUTES_PER_HOUR = 60;

export function formatTotalMinutes(minutes: number): string {
  // A negative total cannot come from the aggregate (it sums a positive-only
  // population), so one here means a malformed payload. Clamping keeps a
  // nonsense number from being dressed up as a readable duration.
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / MINUTES_PER_HOUR);
  const remainder = whole % MINUTES_PER_HOUR;
  if (hours === 0) return `${remainder}m`;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
