/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import {
  REVIEW_LEVEL_ORDER,
  resolveStageTitles,
  reviewEntryParams,
  sortByReviewOrder,
  stageNumberFromScopeKey,
} from '../reviewScopes';

import type { ReflectionDue, Stage } from '@/api';

const mockStagesListAll = jest.fn() as jest.MockedFunction<() => Promise<Stage[]>>;

jest.mock('@/api', () => ({
  stages: {
    listAll: (...a: unknown[]) =>
      (mockStagesListAll as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

function scope(overrides: Partial<ReflectionDue> = {}): ReflectionDue {
  return {
    level: 'week',
    scope_key: 'c1:w2',
    window_start: '2026-07-08T00:00:00Z',
    window_end: '2026-07-15T00:00:00Z',
    existing_entry_id: null,
    ...overrides,
  };
}

function stage(stageNumber: number, title: string): Stage {
  return {
    id: stageNumber,
    title,
    subtitle: 'Beige',
    stage_number: stageNumber,
    overview_url: 'https://example.com',
    category: 'foundation',
    aspect: 'body',
    spiral_dynamics_color: 'Beige',
    growing_up_stage: 'Archaic',
    divine_gender_polarity: 'neutral',
    relationship_to_free_will: 'reactive',
    free_will_description: 'Instinctual survival',
    is_unlocked: true,
    progress: 1,
  };
}

beforeEach(() => {
  mockStagesListAll.mockReset();
  mockStagesListAll.mockResolvedValue([stage(1, 'Survival'), stage(5, 'Achievement')]);
});

describe('stageNumberFromScopeKey', () => {
  it('reads the stage ordinal off a stage key in any cycle', () => {
    expect(stageNumberFromScopeKey('c1:s1')).toBe(1);
    expect(stageNumberFromScopeKey('c2:s10')).toBe(10);
  });

  it('is null for every key that is not a stage', () => {
    expect(stageNumberFromScopeKey('c1:w2')).toBeNull();
    expect(stageNumberFromScopeKey('c1:x1')).toBeNull();
    expect(stageNumberFromScopeKey('c1:course')).toBeNull();
  });
});

describe('resolveStageTitles', () => {
  it('resolves every stage scope from one stages lookup', async () => {
    const titles = await resolveStageTitles([
      scope(),
      scope({ level: 'stage', scope_key: 'c1:s1' }),
      scope({ level: 'stage', scope_key: 'c1:s5' }),
    ]);
    expect(mockStagesListAll).toHaveBeenCalledTimes(1);
    expect(titles.get('c1:s1')).toBe('Survival');
    expect(titles.get('c1:s5')).toBe('Achievement');
    expect(titles.has('c1:w2')).toBe(false);
  });

  it('makes no lookup when no stage scope is present', async () => {
    const titles = await resolveStageTitles([
      scope(),
      scope({ level: 'course', scope_key: 'c1:course' }),
    ]);
    expect(mockStagesListAll).not.toHaveBeenCalled();
    expect(titles.size).toBe(0);
  });

  it('degrades to no titles when the stages lookup fails', async () => {
    mockStagesListAll.mockRejectedValue(new Error('offline'));
    const titles = await resolveStageTitles([scope({ level: 'stage', scope_key: 'c1:s1' })]);
    expect(titles.size).toBe(0);
  });
});

describe('reviewEntryParams', () => {
  it('continues the live review when one already claims the scope', () => {
    expect(reviewEntryParams(scope({ existing_entry_id: 31 }), null)).toEqual({ entryId: 31 });
  });

  it('opens a fresh review with the scope and its titled page otherwise', () => {
    expect(reviewEntryParams(scope({ level: 'stage', scope_key: 'c1:s1' }), 'Survival')).toEqual({
      reflectionLevel: 'stage',
      reflectionScopeKey: 'c1:s1',
      prefillTitle: 'Stage Review — Survival',
    });
  });

  it('titles a stage review plainly when its stage title is unknown', () => {
    expect(reviewEntryParams(scope({ level: 'stage', scope_key: 'c1:s1' }), null)).toEqual({
      reflectionLevel: 'stage',
      reflectionScopeKey: 'c1:s1',
      prefillTitle: 'Stage Review',
    });
  });
});

describe('sortByReviewOrder', () => {
  it('orders scopes narrowest first — week, stage, section, course', () => {
    expect(REVIEW_LEVEL_ORDER).toEqual(['week', 'stage', 'section', 'course']);
    const shuffled = [
      scope({ level: 'course', scope_key: 'c1:course' }),
      scope({ level: 'section', scope_key: 'c1:x1' }),
      scope(),
      scope({ level: 'stage', scope_key: 'c1:s1' }),
    ];
    expect(sortByReviewOrder(shuffled).map((s) => s.level)).toEqual([
      'week',
      'stage',
      'section',
      'course',
    ]);
    // Pure: the caller's array is left as it was.
    expect(shuffled[0]?.level).toBe('course');
  });
});
