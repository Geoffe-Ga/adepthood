/**
 * Pure copy helpers for the hierarchical-reflection surface: the invitation
 * title per scope, a Markdown blockquote for a folded-in quote, and the
 * attribution line beneath it. No React, no I/O — trivially unit-testable.
 *
 * Scope-key grammar (mirrors the backend): ``c{cycle}:{token}`` where the token
 * is one of ``course`` | ``w<n>`` | ``s<n>`` | ``x<n>`` (week / stage / section /
 * course). A section is spelled ``x`` because ``s`` already names a stage and
 * ``c`` already prefixes the cycle.
 */
import type { ReflectionLevel, ReflectionSourceItem } from '@/api';
import { STAGES_PER_SECTION } from '@/constants/program';
import { STAGE_ORDER } from '@/design/tokens';

/** Extracts the week ordinal from a week scope key (``c1:w14`` → ``14``). */
const WEEK_SCOPE_KEY = /^c\d+:w(\d+)$/;

/** Extracts the section ordinal from a section scope key (``c1:x2`` → ``2``). */
const SECTION_SCOPE_KEY = /^c\d+:x(\d+)$/;

/** A week title, degrading gracefully when the scope key is not the ``w<n>`` shape. */
function weekTitle(scopeKey: string): string {
  const week = WEEK_SCOPE_KEY.exec(scopeKey)?.[1];
  return week == null ? 'Weekly Review' : `Weekly Review — Week ${week}`;
}

/**
 * A section title naming the Wavelength turn the section closes.
 *
 * The colour is DERIVED — section ``n`` closes on stage ``STAGES_PER_SECTION *
 * n``, and that stage's name is its colour — rather than written out as a list
 * that could drift from the curriculum. Degrades to the bare label when the
 * scope key is not the ``x<n>`` shape or names a section the curriculum has no
 * stage for.
 */
function sectionTitle(scopeKey: string): string {
  const captured = SECTION_SCOPE_KEY.exec(scopeKey)?.[1];
  const section = captured == null ? Number.NaN : Number.parseInt(captured, 10);
  const closingStage = STAGE_ORDER[STAGES_PER_SECTION * section - 1];
  return closingStage == null ? 'Section Review' : `Section Review — ${closingStage}`;
}

/**
 * The pre-filled title for a review invitation, in the program's own words.
 *
 * A ``week`` reads "Weekly Review — Week 14"; a ``stage`` appends its title
 * when known ("Stage Review — Survival"); a ``section`` names its Wavelength
 * turn ("Section Review — Green"); the whole ``course`` reads "Course Review".
 */
export function reflectionTitle(
  level: ReflectionLevel,
  scopeKey: string,
  stageTitle?: string,
): string {
  if (level === 'week') return weekTitle(scopeKey);
  if (level === 'stage') {
    return stageTitle ? `Stage Review — ${stageTitle}` : 'Stage Review';
  }
  if (level === 'section') return sectionTitle(scopeKey);
  return 'Course Review';
}

/**
 * How many blank lines separate a folded-in quote block from the text around
 * it. One is what Markdown needs to end a quote block, and exactly one keeps
 * two quotes folded in back to back reading as neighbours rather than strangers.
 */
export const BLANK_LINES_BETWEEN_BLOCKS = 1;

/** Line breaks that make {@link BLANK_LINES_BETWEEN_BLOCKS} blank lines. */
const BLOCK_SEPARATOR_BREAKS = BLANK_LINES_BETWEEN_BLOCKS + 1;

/** Prefix every line of ``text`` with the blockquote marker. */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * A Markdown blockquote for a quote folded into the reflection body: every line
 * of the passage quoted, then the source attributed on its own quoted line. It
 * carries no padding of its own; {@link spliceQuoteBlock} sizes the gap to the
 * text actually around the caret.
 */
export function formatBlockquote(anchorText: string, attribution: string): string {
  return `${quoteLines(anchorText)}\n> — ${attribution}`;
}

/**
 * A Markdown blockquote prefill for a whole passage carried into a fresh entry.
 * Every line of ``text`` is quoted, the ``sourceTitle`` is attributed on its own
 * quoted line, and a trailing blank line separates it from anything the writer
 * adds. It is the top of a new body, so it opens with no leading newline.
 */
export function formatQuotePrefill(text: string, sourceTitle: string): string {
  return `${quoteLines(text)}\n> — ${sourceTitle}\n\n`;
}

/** How many line breaks ``text`` ends with (``fromEnd``) or begins with. */
function countBreaks(text: string, fromEnd: boolean): number {
  let count = 0;
  const at = (i: number): string | undefined => text[fromEnd ? text.length - 1 - i : i];
  while (at(count) === '\n') count += 1;
  return count;
}

/** The breaks still needed so that ``existing`` of them make one separator. */
function missingBreaks(existing: number): string {
  return '\n'.repeat(Math.max(0, BLOCK_SEPARATOR_BREAKS - existing));
}

/**
 * Splice a quote ``block`` into ``body`` at the UTF-16 ``caret`` (the end when
 * untracked or past it), padded so exactly {@link BLANK_LINES_BETWEEN_BLOCKS}
 * blank line separates it from the text on each side. Padding only ADDS the
 * line breaks that are missing -- the writer's own text, including extra blank
 * lines they typed, is never removed -- and nothing is added before a block
 * that opens the body. Returns the new text and the caret just past the block's
 * trailing separator, so a second fold-in lands after the first.
 */
export function spliceQuoteBlock(
  body: string,
  block: string,
  caret: number | null,
): { text: string; nextCaret: number } {
  const at = caret == null ? body.length : Math.min(Math.max(caret, 0), body.length);
  const before = body.slice(0, at);
  const after = body.slice(at);
  const lead = before.length === 0 ? '' : missingBreaks(countBreaks(before, true));
  const trail = missingBreaks(countBreaks(after, false));
  const inserted = `${lead}${block}${trail}`;
  return { text: `${before}${inserted}${after}`, nextCaret: at + inserted.length };
}

/**
 * ``short`` month/day/year attribution date (e.g. "Jun 1, 2026"); '' if unparseable.
 *
 * ``timeZone`` is the IANA zone the date should READ in. Pass the account's own
 * zone for anything shown beside the feed: the server windowed the feed on that
 * zone, and formatting in the device's instead can print a day boundary the feed
 * below it disagrees with -- the same two-clocks defect this module's window
 * label exists to close, reintroduced on the display layer. Omitted, it falls
 * back to the device zone, which is what the written-attribution path wants.
 */
export function formatSourceDate(timestamp: string, timeZone?: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/** The two facts an attribution is built from, whichever feed carried them. */
export interface AttributionSource {
  title: string | null | undefined;
  timestamp: string;
}

/**
 * The attribution line written beneath a folded quote: the source's trimmed
 * title, else the day it was written (in the device zone).
 *
 * The ONE composer of that line. The sources panel and the Promoted quotes
 * screen read the same entry through two different feeds, and the batch
 * fold-in decides "already in the body" by looking for the exact rendered
 * block -- so a second, drifting copy of this rule would make the same quote,
 * folded from the other surface, land twice.
 */
export function quoteAttribution(source: AttributionSource): string {
  const title = source.title?.trim();
  return title ? title : formatSourceDate(source.timestamp);
}

/** The attribution shown beneath a folded quote: the source's title, else its date. */
export function sourceAttribution(item: ReflectionSourceItem): string {
  return quoteAttribution(item);
}

/**
 * The date shown ALONGSIDE a source's row header, so a titled source still says
 * when it was written and the reader can see the feed matches the review period.
 * Deliberately separate from {@link sourceAttribution}, which also composes the
 * attribution line written into a saved reflection body — changing that would
 * rewrite journal text, not just what is on screen. '' when unparseable.
 */
export function sourceDateLabel(item: ReflectionSourceItem, timeZone?: string): string {
  return formatSourceDate(item.timestamp, timeZone);
}

/** The half-open calendar period a review covers, exactly as the server declared it. */
export interface ReviewWindow {
  /** First instant of the review's first day. */
  start: string;
  /** EXCLUSIVE: the first instant of the day AFTER the review's last day. */
  end: string;
}

/**
 * Half a day, in milliseconds — the step back from an EXCLUSIVE local-midnight
 * end to a point INSIDE the last day the review actually covers.
 *
 * A full 24-hour step is wrong across a daylight-saving boundary. When that last
 * day is a 23-hour spring-forward day, 24 hours overshoots it and lands an hour
 * before its own midnight, so the label reads a day short. Any step strictly
 * between 0 and 23 hours stays inside the day whichever way the clock moved, so
 * midday is the anchor that is safe in both directions. The backend windows this
 * period on real local midnights (``program_week_bounds``); this keeps the label
 * agreeing with it (#2892 review).
 */
const HALF_DAY_MS = 12 * 60 * 60 * 1000;

/**
 * The review period label, e.g. "Jun 1 – Jun 7, 2026".
 *
 * Built only from the two instants the SERVER declared it filtered on: ``start``
 * inclusive and ``end`` EXCLUSIVE, so the last day shown is the day before
 * ``end``. Nothing here reads the scope key or the program constants — a label
 * derived on the client could disagree with the feed beside it, which is the
 * whole defect this closes. Returns '' when either bound is missing or
 * unparseable, and the caller then shows no label.
 */
export function formatReviewPeriod(start: string, end: string, timeZone?: string): string {
  const from = new Date(start);
  const exclusiveTo = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(exclusiveTo.getTime())) return '';
  const to = new Date(exclusiveTo.getTime() - HALF_DAY_MS);
  if (to.getTime() < from.getTime()) return '';
  const fromLabel = from.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return `${fromLabel} – ${formatSourceDate(to.toISOString(), timeZone)}`;
}
