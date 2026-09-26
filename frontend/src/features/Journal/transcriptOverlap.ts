/**
 * Find where two consecutive transcribed pages repeat each other at their seam.
 *
 * Screenshots of one message thread overlap: the bottom of one is the top of the
 * next, and the crop often cuts a line in half at either edge. This module decides,
 * for one pair of adjacent pages, how many of the later page's leading lines are
 * already on the earlier page, and whether the earlier page ends on a cropped line
 * the later page shows whole — so the merge can emit each line once.
 *
 * It is deliberately CONSERVATIVE. A writer really can repeat a line ("ok",
 * "Me: same"), and a false merge would silently delete their words; a missed merge
 * only leaves a repeat they can tidy by hand. So a seam only counts when its full,
 * uncropped matching lines clear a bar on their own (see
 * {@link MIN_OVERLAP_LINES} / {@link MIN_SINGLE_LINE_OVERLAP_CHARS}); a cropped
 * fragment is only ever trimmed alongside such a run, never counted toward it; and
 * the scan is bounded by {@link MAX_SEAM_LINES}.
 *
 * PURE: no logging, no side effects, and it never changes a page's stored text —
 * it only describes an overlap that the derived merge may apply (and the writer
 * may decline with "Keep them").
 */

/** Normalized edit-distance similarity at or above which two lines are "the same"
 *  (one OCR slip in ten characters) — lower starts matching genuinely new replies. */
export const LINE_SIMILARITY_THRESHOLD = 0.9;

/** Full matching lines a seam needs, so one coincidental repeat is never dropped. */
export const MIN_OVERLAP_LINES = 2;

/** A lone matching line only counts when it is at least this long (normalized), so
 *  a short, plausibly real repeat like "Me: ok" is kept. */
export const MIN_SINGLE_LINE_OVERLAP_CHARS = 24;

/** A cropped edge fragment is only trimmed when at least this long (normalized), so
 *  a stray word that happens to end the earlier line is not taken for a crop. */
export const MIN_FRAGMENT_CHARS = 8;

/** The furthest from the seam the scan looks, in lines — keeps the cost bounded
 *  (a screenshot overlap is a few lines, never a whole long page). */
export const MAX_SEAM_LINES = 20;

/** No fragment at this edge. */
const NO_CROP = 0;

/** One cropped fragment at this edge — a crop cuts at most one line. */
const ONE_CROP = 1;

/** The crop choices tried at each run length, cropped first so a whole line that a
 *  cropped fragment belongs to is preferred over a looser alignment. */
const CROP_OPTIONS = [ONE_CROP, NO_CROP] as const;

/** Similarity of two identical (or both empty) lines. */
const IDENTICAL = 1;

/** The shortest run the scan tries: a single line (which then needs to be long). */
const SHORTEST_RUN = 1;

/** A later page's cropped head fragment is always its first line. */
const FIRST_LINE = 0;

/** Levenshtein costs: an insertion, deletion or substitution costs one edit. */
const EDIT_COST = 1;
const NO_COST = 0;

/** The transcription service's own placeholders: never evidence of a repeat. */
const MARKER_LINES: ReadonlySet<string> = new Set(['[illegible]', '[no text found]']);

/**
 * How one seam's overlap is applied by the merge: the later page's first
 * `laterLinesToDrop` lines are dropped, and the earlier page's last
 * `earlierLinesToReplace` line(s) — a cropped tail — give way to the later page's
 * whole copy. `noticeLineCount` is the count the writer is told about.
 */
export interface SeamOverlap {
  laterLinesToDrop: number;
  earlierLinesToReplace: number;
  noticeLineCount: number;
}

/** The one line splitter the matcher and the merge share: page edges trimmed. */
export function seamLines(text: string): string[] {
  return text.trim().split('\n');
}

/** Fold the differences a transcription introduces but a reader would not see:
 *  compatibility forms, case, curly quotes, dash variants, and runs of whitespace. */
export function normalizeTranscriptLine(line: string): string {
  return line
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[\u2018\u2019\u201A\u201B\u2032]/gu, "'")
    .replaceAll(/[\u201C\u201D\u201E\u2033]/gu, '"')
    .replaceAll(/[\u2010-\u2015\u2212]/gu, '-')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

/** Classic Levenshtein distance, one row at a time (no band, no cache: a seam is a
 *  handful of short lines, so the full table is cheap and exact at the threshold). */
function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let distance = b.length;
  for (let i = 1; i <= a.length; i += 1) {
    const char = a[i - 1];
    const current = [i];
    let left = i;
    let diagonal = i - EDIT_COST;
    previous.slice(1).forEach((above, j) => {
      const substitution = diagonal + (char === b[j] ? NO_COST : EDIT_COST);
      left = Math.min(above + EDIT_COST, left + EDIT_COST, substitution);
      diagonal = above;
      current.push(left);
    });
    previous = current;
    distance = left;
  }
  return distance;
}

/** 1 − (edit distance ÷ the longer length): 1 for identical lines, 0 for disjoint. */
export function lineSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return IDENTICAL;
  return IDENTICAL - levenshtein(a, b) / longest;
}

/** Whether two normalized lines are one line read twice. Blank lines and service
 *  markers never match, so they break a run rather than extend it. */
function linesMatch(a: string, b: string): boolean {
  if (a === '' || b === '' || MARKER_LINES.has(a) || MARKER_LINES.has(b)) return false;
  return lineSimilarity(a, b) >= LINE_SIMILARITY_THRESHOLD;
}

/**
 * The line at `index`, or an empty line off either end of the page. This is the
 * matcher's bounds check: an empty line never matches and never hosts a fragment,
 * so a candidate that reaches past either page simply fails.
 */
function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? '';
}

/** `part` is a strictly shorter prefix of `whole`. */
function isStrictPrefix(part: string, whole: string): boolean {
  return part.length < whole.length && whole.startsWith(part);
}

/** `part` is a strictly shorter suffix of `whole`. */
function isStrictSuffix(part: string, whole: string): boolean {
  return part.length < whole.length && whole.endsWith(part);
}

/** A crop fragment worth trimming: a strict prefix/suffix and not too short. */
function isFragment(part: string, whole: string, strict: typeof isStrictPrefix): boolean {
  return part.length >= MIN_FRAGMENT_CHARS && strict(part, whole);
}

/** One candidate alignment: a run of `k` full lines, with an optional cropped head
 *  fragment on the later page (`f`) and cropped tail on the earlier page (`r`). */
interface Candidate {
  k: number;
  f: number;
  r: number;
}

/** Every full line of the run matches its partner across the seam. */
function runMatches(earlier: readonly string[], later: readonly string[], c: Candidate): boolean {
  const start = earlier.length - c.r - c.k;
  for (let i = 0; i < c.k; i += 1) {
    if (!linesMatch(lineAt(earlier, start + i), lineAt(later, c.f + i))) return false;
  }
  return true;
}

/** The run clears the bar on its full lines alone — fragments never count. */
function runQualifies(earlier: readonly string[], later: readonly string[], c: Candidate): boolean {
  if (c.k >= MIN_OVERLAP_LINES) return true;
  const shorter = Math.min(
    lineAt(earlier, earlier.length - c.r - c.k).length,
    lineAt(later, c.f).length,
  );
  return shorter >= MIN_SINGLE_LINE_OVERLAP_CHARS;
}

/** The edges around the run are consistent with a crop (or with none). */
function edgesHold(earlier: readonly string[], later: readonly string[], c: Candidate): boolean {
  const last = lineAt(earlier, earlier.length - 1);
  // A cropped tail is always a replacement, never a fuzzy match: if the run's own
  // last earlier line is a cut-short copy of its partner, keeping it would drop
  // the whole line and keep the partial one.
  if (c.r === NO_CROP && isStrictPrefix(last, lineAt(later, c.f + c.k - 1))) return false;
  if (c.r === ONE_CROP && !isFragment(last, lineAt(later, c.f + c.k), isStrictPrefix)) return false;
  const beforeRun = lineAt(earlier, earlier.length - c.r - c.k - ONE_CROP);
  return c.f === NO_CROP || isFragment(lineAt(later, FIRST_LINE), beforeRun, isStrictSuffix);
}

/** Whether one alignment is a genuine, qualifying overlap. */
function candidateHolds(
  earlier: readonly string[],
  later: readonly string[],
  c: Candidate,
): boolean {
  return (
    runMatches(earlier, later, c) && edgesHold(earlier, later, c) && runQualifies(earlier, later, c)
  );
}

/** The first qualifying alignment for a run of exactly `k` lines, if any. */
function candidateAt(
  earlier: readonly string[],
  later: readonly string[],
  k: number,
): Candidate | null {
  for (const f of CROP_OPTIONS) {
    for (const r of CROP_OPTIONS) {
      const candidate = { k, f, r };
      if (candidateHolds(earlier, later, candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The overlap at the seam between an `earlier` page and the `later` page that
 * follows it, or `null` when there is none worth removing. The longest qualifying
 * run wins; within a run length, an alignment that accounts for cropped edges is
 * preferred.
 */
export function findSeamOverlap(earlier: string, later: string): SeamOverlap | null {
  const earlierLines = seamLines(earlier).map(normalizeTranscriptLine);
  const laterLines = seamLines(later).map(normalizeTranscriptLine);
  const longest = Math.min(MAX_SEAM_LINES, earlierLines.length, laterLines.length);
  for (let k = longest; k >= SHORTEST_RUN; k -= 1) {
    const found = candidateAt(earlierLines, laterLines, k);
    if (found) {
      return {
        laterLinesToDrop: found.f + found.k,
        earlierLinesToReplace: found.r,
        noticeLineCount: found.f + found.k + found.r,
      };
    }
  }
  return null;
}
