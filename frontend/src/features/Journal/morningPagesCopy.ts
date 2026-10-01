/**
 * Microcopy for the morning-pages tip — the shelf's daily, declinable
 * invitation to write (NORTH-STAR "you choose your depth").
 *
 * The tip reads like a friend passing along a practice worth trying, never a
 * prescription. It can be set aside for today (the corner X), turned down for
 * good ("Don't show this again"), and offered again from Settings → Journal.
 * There is no streak, no count, and no pressure to continue — so nothing here
 * ranks, shames, or pushes. ``MORNING_PAGES_COPY_ENTRIES`` enumerates every
 * user-facing string, card and Settings alike, for the balance-not-altitude
 * sweep.
 */

/** The uppercase caption above the tip — frames it as an offer, not a task. */
export const MORNING_PAGES_LABEL = 'A practice to try';

/** The tip heading — names the practice plainly. */
export const MORNING_PAGES_TITLE = 'Morning pages';

/** The stable suffix used after the local calendar date on a new page. */
export const MORNING_PAGES_TITLE_SUFFIX = 'Daily Journal';

/** Shelf-safe name shared by every door into this daily writing practice. */
export const morningPageTitle = (isoDate: string): string =>
  `${isoDate} ${MORNING_PAGES_TITLE_SUFFIX}`;

/** The tip body — what the practice is, framed as an invitation to let it pour. */
export const MORNING_PAGES_BODY =
  'Twenty minutes of unfiltered writing, first thing — no editing, no rereading, just let it pour. It clears the fog before the day begins.';

/** The open affordance label — starts a fresh page. */
export const MORNING_PAGES_CTA = 'Begin a page';

/**
 * The accessibility label for beginning a morning page. It opens with the
 * visible CTA's own words so a voice-control user can say what they see
 * (WCAG 2.5.3, label in name), then names the practice for a screen reader.
 */
export const MORNING_PAGES_CTA_A11Y = `${MORNING_PAGES_CTA} of morning pages`;

/**
 * The only name the set-aside-for-today has: it is an icon-only X in the
 * card's corner (#2860), so this label is what a screen reader speaks and a
 * voice user says. The tip is back the next day.
 */
export const MORNING_PAGES_DISMISS_A11Y = 'Set the morning-pages tip aside';

/** The quiet in-card link that stops the tip being offered at all (#3005). */
export const MORNING_PAGES_NEVER_LINK = 'Don’t show this again';

/**
 * The link's accessibility label: its own visible words first, so a voice
 * user can say what they see (WCAG 2.5.3), then what it stops.
 */
export const MORNING_PAGES_NEVER_A11Y = `${MORNING_PAGES_NEVER_LINK}: stop offering morning pages on the shelf`;

/**
 * Settings → Journal: bring the tip back after "Don't show this again". The
 * decline it clears is kept on this device only, so the copy says so.
 */
export const MORNING_PAGES_OFFER_AGAIN_LABEL = 'Offer morning pages again';
export const MORNING_PAGES_OFFER_AGAIN_DESCRIPTION =
  'Puts the morning-pages invitation back on your Journal shelf, on this device.';
export const MORNING_PAGES_OFFER_AGAIN_DONE =
  'Morning pages are on your Journal shelf again on this device.';

/** Every string the card itself shows or speaks. */
export const MORNING_PAGES_CARD_COPY_ENTRIES: readonly string[] = [
  MORNING_PAGES_LABEL,
  MORNING_PAGES_TITLE,
  MORNING_PAGES_TITLE_SUFFIX,
  MORNING_PAGES_BODY,
  MORNING_PAGES_CTA,
  MORNING_PAGES_CTA_A11Y,
  MORNING_PAGES_DISMISS_A11Y,
  MORNING_PAGES_NEVER_LINK,
  MORNING_PAGES_NEVER_A11Y,
];

/** Every string the Settings → Journal row shows or speaks. */
export const MORNING_PAGES_SETTINGS_COPY_ENTRIES: readonly string[] = [
  MORNING_PAGES_OFFER_AGAIN_LABEL,
  MORNING_PAGES_OFFER_AGAIN_DESCRIPTION,
  MORNING_PAGES_OFFER_AGAIN_DONE,
];

/** Every user-facing morning-pages string, gathered for the balance-not-altitude sweep. */
export const MORNING_PAGES_COPY_ENTRIES: readonly string[] = [
  ...MORNING_PAGES_CARD_COPY_ENTRIES,
  ...MORNING_PAGES_SETTINGS_COPY_ENTRIES,
];
