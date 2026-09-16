/**
 * Pure copy helpers for the hierarchical-reflection surface: the invitation
 * title per scope, a Markdown blockquote for a folded-in quote, and the
 * attribution line beneath it. No React, no I/O — trivially unit-testable.
 *
 * Scope-key grammar (mirrors the backend): ``c{cycle}:{token}`` where the token
 * is one of ``prog`` | ``w<n>`` | ``s<n>`` | ``p<n>`` | ``t<n>`` (week / stage /
 * component / tier / program).
 */
import type { ReflectionLevel, ReflectionSourceItem } from '@/api';

/** Extracts the week ordinal from a week scope key (``c1:w14`` → ``14``). */
const WEEK_SCOPE_KEY = /^c\d+:w(\d+)$/;

/** The fixed titles for the breadth levels that carry no per-scope number. */
const FIXED_LEVEL_TITLES: Record<Exclude<ReflectionLevel, 'week' | 'stage'>, string> = {
  component: 'Component Reflection',
  tier: 'Tier Reflection',
  program: 'Program Reflection',
};

/** A week title, degrading gracefully when the scope key is not the ``w<n>`` shape. */
function weekTitle(scopeKey: string): string {
  const week = WEEK_SCOPE_KEY.exec(scopeKey)?.[1];
  return week == null ? 'Week Reflection' : `Week ${week} Reflection`;
}

/**
 * The pre-filled title for a reflection invitation. A ``week`` reads
 * "Week 14 Reflection"; a ``stage`` appends its title when known
 * ("Stage Reflection — Survival"); the broader levels use their fixed label.
 */
export function reflectionTitle(
  level: ReflectionLevel,
  scopeKey: string,
  stageTitle?: string,
): string {
  if (level === 'week') return weekTitle(scopeKey);
  if (level === 'stage') {
    return stageTitle ? `Stage Reflection — ${stageTitle}` : 'Stage Reflection';
  }
  return FIXED_LEVEL_TITLES[level];
}

/**
 * A Markdown blockquote for a quote folded into the reflection body. Opens on a
 * fresh line, attributes the source on its own quoted line, and closes with a
 * blank line so it never runs into surrounding prose.
 */
export function formatBlockquote(anchorText: string, attribution: string): string {
  return `\n> ${anchorText}\n> — ${attribution}\n\n`;
}

/**
 * A Markdown blockquote prefill for a whole passage carried into a fresh entry.
 * Every line of ``text`` is quoted, the ``sourceTitle`` is attributed on its own
 * quoted line, and a trailing blank line separates it from anything the writer
 * adds. Unlike ``formatBlockquote`` it opens with no leading newline — it is the
 * top of a new body — and quotes multi-line passages line by line.
 */
export function formatQuotePrefill(text: string, sourceTitle: string): string {
  const quotedLines = text.split('\n').map((line) => `> ${line}`);
  return `${quotedLines.join('\n')}\n> — ${sourceTitle}\n\n`;
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
function formatSourceDate(timestamp: string, timeZone?: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/** The attribution shown beneath a folded quote: the source's title, else its date. */
export function sourceAttribution(item: ReflectionSourceItem): string {
  const title = item.title?.trim();
  return title ? title : formatSourceDate(item.timestamp);
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
