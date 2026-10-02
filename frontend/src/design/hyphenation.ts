/**
 * Where a Map category word may break when it cannot fit its narrow column.
 *
 * The right column of the Map sets each row's category on one line at the
 * largest Candle & Ink ramp step it fits (``fitRightLabel``). A word too long
 * even for the caption step falls back to the lines listed here, broken where a
 * typesetter would break it, rather than where the platform's own hyphenator
 * happens to. This is typographic design data, keyed by the word itself: the
 * words come from the server (``GET /stages``), and a word with no entry is set
 * as one line, which ``fitRightLabel`` then lets wrap inside its cell.
 */

/** The break points for each category word that has needed one (#2666). */
export const HYPHENATION_BREAKS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Awareness', ['Aware-', 'ness']],
  ['Understanding', ['Under-', 'standing']],
  ['Yes-And-Ness', ['Yes-And-', 'Ness']],
]);

/** The lines ``word`` breaks into, or the whole word on one line when unlisted. */
export const hyphenate = (word: string): readonly string[] =>
  HYPHENATION_BREAKS.get(word) ?? [word];
