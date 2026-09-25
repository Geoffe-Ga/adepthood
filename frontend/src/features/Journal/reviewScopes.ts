/**
 * Pure helpers shared by every door into a review (issue #2867): the due-day
 * invitation on the shelf and the early-review picker, which a later screen
 * (the Promoted quotes list, #2865) can mount too.
 *
 * ``reviewEntryParams`` is the single home of the navigation contract — a
 * scope already claimed by a live review reopens THAT entry, and any other
 * opens a fresh page carrying the scope and its program title — so no caller
 * can start a second review on a scope the writer has already begun.
 */
import { reflectionTitle } from './reflectionCopy';

import { stages } from '@/api';
import type { ReflectionDue, ReflectionLevel } from '@/api';

/** A review scope as both ``/reflections/due`` and ``/reflections/current`` shape it. */
export type ReviewScope = ReflectionDue;

/** The layers in the order a writer meets them: narrowest first. */
export const REVIEW_LEVEL_ORDER: readonly ReflectionLevel[] = [
  'week',
  'stage',
  'section',
  'course',
];

/** Extracts the stage ordinal from a stage scope key (``c1:s1`` → ``1``). */
const STAGE_SCOPE_KEY = /^c\d+:s(\d+)$/;

/** The JournalEntry params that open a review: continue it, or begin it. */
export type ReviewEntryParams =
  | { entryId: number }
  | { reflectionLevel: ReflectionLevel; reflectionScopeKey: string; prefillTitle: string };

/** The stage ordinal a stage scope key names, or null for any other key. */
export function stageNumberFromScopeKey(scopeKey: string): number | null {
  const captured = STAGE_SCOPE_KEY.exec(scopeKey)?.[1];
  return captured == null ? null : Number.parseInt(captured, 10);
}

/**
 * Each stage scope's title, keyed by scope key, from ONE stages lookup — and
 * none at all when no stage scope is present. Any failure yields an empty map,
 * so the review is titled plainly ("Stage Review") rather than not offered.
 */
export async function resolveStageTitles(
  scopes: readonly ReviewScope[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const wanted = scopes.filter((scope) => scope.level === 'stage');
  if (wanted.length === 0) return titles;
  try {
    const all = await stages.listAll();
    for (const scope of wanted) {
      const stageNumber = stageNumberFromScopeKey(scope.scope_key);
      const found = all.find((candidate) => candidate.stage_number === stageNumber);
      if (found != null) titles.set(scope.scope_key, found.title);
    }
  } catch {
    titles.clear();
  }
  return titles;
}

/** The program's own title for a scope, e.g. "Weekly Review — Week 2". */
export function reviewTitle(scope: ReviewScope, stageTitle: string | null): string {
  return reflectionTitle(scope.level, scope.scope_key, stageTitle ?? undefined);
}

/** Where pressing a review goes: the live review claiming the scope, else a fresh page. */
export function reviewEntryParams(
  scope: ReviewScope,
  stageTitle: string | null,
): ReviewEntryParams {
  if (scope.existing_entry_id != null) return { entryId: scope.existing_entry_id };
  return {
    reflectionLevel: scope.level,
    reflectionScopeKey: scope.scope_key,
    prefillTitle: reviewTitle(scope, stageTitle),
  };
}

/** A copy of ``scopes`` ordered narrowest first, whatever order they arrived in. */
export function sortByReviewOrder<T extends ReviewScope>(scopes: readonly T[]): T[] {
  return [...scopes].sort(
    (a, b) => REVIEW_LEVEL_ORDER.indexOf(a.level) - REVIEW_LEVEL_ORDER.indexOf(b.level),
  );
}
