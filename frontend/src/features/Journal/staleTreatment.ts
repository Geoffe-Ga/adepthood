/**
 * The one dimming a Journal surface applies to an anchor that has come adrift
 * from its passage: a margin note the server marked ``stale`` and a promoted
 * quote whose ``stale`` flag is set after an edit. Shared so the two read as
 * the same state rather than two near-identical greys.
 */

/** Opacity of a stale anchor's card; the full-ink caption beside it names why. */
export const STALE_OPACITY = 0.55;
