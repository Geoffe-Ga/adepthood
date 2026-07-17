/**
 * Dependency-free fuzzy matcher for drawer search: a bag-of-tokens model that
 * folds diacritics, treats punctuation as whitespace, and tolerates a bounded
 * typo (edit distance one) or dropped characters (subsequence) per token. Pure
 * functions only — no React, no I/O.
 */

/** Minimum token length before typo/subsequence tolerance kicks in. */
const MIN_FUZZY_TOKEN_LENGTH = 3;

// Relative token weights: exact beats prefix beats substring beats fuzzy.
const EXACT_TOKEN_SCORE = 4;
const PREFIX_TOKEN_SCORE = 3;
const SUBSTRING_TOKEN_SCORE = 2;
const FUZZY_TOKEN_SCORE = 1;
const NO_MATCH_SCORE = 0;

/** Positive sentinel so an empty query ranks every candidate equally. */
const EMPTY_QUERY_SCORE = 1;

/** The most edits an approximate token match may span. */
const MAX_EDIT_DISTANCE = 1;

// Combining marks left behind after NFD folding (the accents on decomposed letters).
const COMBINING_MARKS = /\p{M}/gu;
// Any run of non-letter, non-digit characters — punctuation, dashes, spaces.
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;
const WHITESPACE = /\s+/u;

/** Fold accents, lowercase, and split into alphanumeric tokens. */
function tokenize(value: string): string[] {
  const folded = value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, ' ')
    .trim();
  return folded.length === 0 ? [] : folded.split(WHITESPACE);
}

/** True when two equal-length strings differ in at most one position. */
function withinOneSubstitution(a: string, b: string): boolean {
  let diffs = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) diffs += 1;
    if (diffs > MAX_EDIT_DISTANCE) return false;
  }
  return true;
}

/** True when the longer string is the shorter one with a single extra character. */
function withinOneIndel(shorter: string, longer: string): boolean {
  let i = 0;
  let skipped = false;
  for (let j = 0; j < longer.length; j += 1) {
    if (shorter[i] === longer[j]) {
      i += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
    }
  }
  return true;
}

/** True when a and b differ by at most one insert, delete, or substitution. */
function editDistanceWithinOne(a: string, b: string): boolean {
  const lengthGap = Math.abs(a.length - b.length);
  if (lengthGap > MAX_EDIT_DISTANCE) return false;
  if (lengthGap === 0) return withinOneSubstitution(a, b);
  return a.length < b.length ? withinOneIndel(a, b) : withinOneIndel(b, a);
}

/** True when every character of q appears in c in order (gaps allowed). */
function isSubsequence(q: string, c: string): boolean {
  let matched = 0;
  for (let j = 0; j < c.length && matched < q.length; j += 1) {
    if (q[matched] === c[j]) matched += 1;
  }
  return matched === q.length;
}

/** Approximate match gated by the minimum-length guard. */
function isFuzzyTokenMatch(queryToken: string, candidateToken: string): boolean {
  return (
    queryToken.length >= MIN_FUZZY_TOKEN_LENGTH &&
    (editDistanceWithinOne(queryToken, candidateToken) || isSubsequence(queryToken, candidateToken))
  );
}

/** Weighted score for one query token against one candidate token. */
function scoreTokenPair(queryToken: string, candidateToken: string): number {
  if (queryToken === candidateToken) return EXACT_TOKEN_SCORE;
  if (candidateToken.startsWith(queryToken)) return PREFIX_TOKEN_SCORE;
  if (candidateToken.includes(queryToken)) return SUBSTRING_TOKEN_SCORE;
  if (isFuzzyTokenMatch(queryToken, candidateToken)) return FUZZY_TOKEN_SCORE;
  return NO_MATCH_SCORE;
}

/** Best score for a query token across all candidate tokens. */
function bestTokenScore(queryToken: string, candidateTokens: readonly string[]): number {
  let best = NO_MATCH_SCORE;
  for (const candidateToken of candidateTokens) {
    const score = scoreTokenPair(queryToken, candidateToken);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Total match strength: 0 when any query token matches nothing, a positive sum
 * otherwise. An empty query yields the sentinel so all candidates tie.
 */
function fuzzyScore(query: string, candidate: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return EMPTY_QUERY_SCORE;
  const candidateTokens = tokenize(candidate);
  let total = NO_MATCH_SCORE;
  for (const queryToken of queryTokens) {
    const best = bestTokenScore(queryToken, candidateTokens);
    if (best === NO_MATCH_SCORE) return NO_MATCH_SCORE;
    total += best;
  }
  return total;
}

/** True when the candidate satisfies every token of the query. */
export function fuzzyMatch(query: string, candidate: string): boolean {
  return fuzzyScore(query, candidate) > NO_MATCH_SCORE;
}

/**
 * Keep and order the items whose text matches the query, strongest first. Ties
 * preserve input order (Array.prototype.sort is stable); an empty query returns
 * every item untouched.
 */
export function rankMatches<T>(
  query: string,
  items: readonly T[],
  getText: (_item: T) => string,
): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, getText(item)) }))
    .filter((entry) => entry.score > NO_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}
