/**
 * Single source of truth for rendering a practice duration. Every surface
 * (catalog rows, detail badge, …) phrases it the same way so the copy never
 * drifts between screens.
 *
 * Rounds to whole minutes — sub-minute precision is noise for a practice
 * length, and the API already stores minutes.
 */
export function formatDuration(minutes: number): string {
  return `${Math.round(minutes)} min`;
}
