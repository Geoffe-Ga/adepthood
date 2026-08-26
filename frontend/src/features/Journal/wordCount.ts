/**
 * The journal's word count: one definition of "a word", shared by every
 * surface that reports one.
 *
 * Splitting on whitespace — the obvious implementation, and the one the shelf's
 * reading-time estimate still uses — is wrong in both directions on real prose.
 * It counts a lone em dash or a row of asterisks as words, and it counts
 * ``time—space`` as one word when a reader sees two. This module states the rule
 * explicitly instead:
 *
 *  - A word is a run of letters, digits, and combining marks.
 *  - An apostrophe (straight or typographic) or a hyphen (ASCII or Unicode)
 *    joins two such runs into ONE word, so ``don't`` and ``well-being`` count
 *    once each. Every other dash — em, en, figure — separates.
 *  - A period or comma joins only when digits follow it, so ``3.14`` and
 *    ``1,000`` count once while a missing space in ``ended.Then`` still counts
 *    two. (The cost of that trade is that ``a.m.`` counts as two; a mistyped
 *    sentence boundary is far likelier in a journal than an abbreviation.)
 *  - Punctuation and emoji are not words, so a page of ``***`` counts zero.
 *  - Han and Kana characters are each their own word, because those scripts are
 *    written without spaces and whitespace-splitting would count a whole
 *    sentence as one. Hangul is deliberately NOT in that set: Korean *is*
 *    space-separated, so it counts like any other prose.
 *
 * Unicode property escapes rather than ``Intl.Segmenter``, whose Hermes /
 * React Native availability is unreliable — the same call ``excerpt`` makes.
 */

/**
 * Characters from scripts written without spaces between words, which therefore
 * count one-per-character: Hiragana and Katakana (U+3040–U+30FF), CJK Unified
 * Ideographs and their Extension A (U+3400–U+4DBF, U+4E00–U+9FFF), the
 * compatibility ideographs (U+F900–U+FAFF), and Extension B (U+20000–U+2A6DF).
 */
const IDEOGRAPHIC = /[぀-ヿ㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}]/gu;

/**
 * One word: a run of letters/digits/marks, extended by an apostrophe- or
 * hyphen-joined run, or by a period/comma that digits follow.
 */
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’‐-][\p{L}\p{N}\p{M}]+|[.,]\p{N}+)*/gu;

/** Thousands separator for the rendered count — ``1,234 words`` reads at a glance. */
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

/** How many words a body holds, under the rule this module documents. */
export function countWords(body: string): number {
  const ideographs = body.match(IDEOGRAPHIC)?.length ?? 0;
  // Ideographs are letters, so they would also match WORD — and a run of them
  // would match as a single word. Blank them out before the second pass.
  const spaced = ideographs === 0 ? body : body.replace(IDEOGRAPHIC, ' ');
  return ideographs + (spaced.match(WORD)?.length ?? 0);
}

/**
 * The count as the writer sees it — pluralised, thousands-grouped, and empty at
 * zero. A blank page says nothing rather than announcing a nought: "you choose
 * your depth" means the journal never opens by scoring you.
 */
export function wordCountLabel(count: number): string {
  if (count === 0) return '';
  const grouped = String(count).replace(THOUSANDS, ',');
  return `${grouped} ${count === 1 ? 'word' : 'words'}`;
}
