/**
 * Microcopy for the morning-pages tip — a one-time, declinable suggestion on
 * the Journal shelf (NORTH-STAR "you choose your depth").
 *
 * The tip reads like a friend passing along a practice worth trying, never a
 * prescription. There is no streak, no count, and no pressure to continue —
 * so nothing here ranks, shames, or pushes. ``MORNING_PAGES_COPY_ENTRIES``
 * enumerates every user-facing string for the balance-not-altitude sweep.
 */

/** The uppercase caption above the tip — frames it as an offer, not a task. */
export const MORNING_PAGES_LABEL = 'A practice to try';

/** The tip heading — names the practice plainly. */
export const MORNING_PAGES_TITLE = 'Morning pages';

/** The tip body — what the practice is, framed as an invitation to let it pour. */
export const MORNING_PAGES_BODY =
  'Twenty minutes of unfiltered writing, first thing — no editing, no rereading, just let it pour. It clears the fog before the day begins.';

/** The open affordance label — starts a fresh page. */
export const MORNING_PAGES_CTA = 'Begin a page';

/** The accessibility label for beginning a morning page. */
export const MORNING_PAGES_CTA_A11Y = 'Begin a morning page';

/** The decline affordance label. */
export const MORNING_PAGES_DISMISS = 'Not now';

/** The accessibility label for declining the tip. */
export const MORNING_PAGES_DISMISS_A11Y = 'Set the morning-pages tip aside';

/** Every user-facing morning-pages string, gathered for the balance-not-altitude sweep. */
export const MORNING_PAGES_COPY_ENTRIES: readonly string[] = [
  MORNING_PAGES_LABEL,
  MORNING_PAGES_TITLE,
  MORNING_PAGES_BODY,
  MORNING_PAGES_CTA,
  MORNING_PAGES_CTA_A11Y,
  MORNING_PAGES_DISMISS,
  MORNING_PAGES_DISMISS_A11Y,
];
