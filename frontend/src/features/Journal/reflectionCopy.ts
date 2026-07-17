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

/** ``short`` month/day/year attribution date (e.g. "Jun 1, 2026"); '' if unparseable. */
function formatSourceDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The attribution shown beneath a folded quote: the source's title, else its date. */
export function sourceAttribution(item: ReflectionSourceItem): string {
  const title = item.title?.trim();
  return title ? title : formatSourceDate(item.timestamp);
}
