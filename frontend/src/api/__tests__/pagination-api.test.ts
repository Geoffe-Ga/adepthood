/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fetchAllPages, habits, practices, stages, course, ApiValidationError } from '../index';

// Mock global fetch
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

// Silence the API_BASE_URL import — just needs a string value
jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

/** A well-formed Page envelope wrapping the supplied items. */
function page(items: unknown[], over: Record<string, unknown> = {}) {
  return {
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    has_more: false,
    ...over,
  };
}

// Valid item builders — the paginated endpoints now validate items per their
// Zod schema (issue audit-contracts-04), so list fixtures must be well-formed.
const validStage = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Beige',
  subtitle: 'Survival',
  stage_number: 1,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: 'Instinctual survival',
  is_unlocked: true,
  progress: 0,
  ...over,
});
const validPractice = (over: Record<string, unknown> = {}) => ({
  id: 1,
  stage_number: 3,
  name: 'Box Breath',
  description: 'desc',
  instructions: 'inst',
  default_duration_minutes: 5,
  submitted_by_user_id: null,
  approved: true,
  ...over,
});
const validContentItem = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Intro',
  content_type: 'essay',
  release_day: 0,
  url: null,
  is_locked: false,
  is_read: false,
  ...over,
});

describe('paginated list endpoints (Page envelope)', () => {
  test('a malformed envelope (missing has_more) raises ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }), // no has_more
    );

    await expect(stages.listAll('tok')).rejects.toThrow(ApiValidationError);
  });

  test('a non-array items field raises ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ items: 'nope', total: 0, limit: 50, offset: 0, has_more: false }),
    );

    await expect(stages.listAll('tok')).rejects.toThrow(ApiValidationError);
  });
});

describe('fetchAllPages + listAll helpers (issue #408 — screen adoption)', () => {
  test('fetchAllPages drains pages until has_more is false', async () => {
    const pages = [
      page([{ id: 1 }, { id: 2 }], { total: 3, has_more: true }),
      page([{ id: 3 }], { total: 3, offset: 2 }),
    ];
    const fetchPage = jest.fn((params: { offset?: number }) =>
      Promise.resolve(pages[params.offset ? 1 : 0]),
    );

    const items = await fetchAllPages(fetchPage as Parameters<typeof fetchAllPages>[0]);

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1]?.[0]?.offset).toBe(2);
  });

  test('fetchAllPages stops on an empty page even if has_more lies', async () => {
    const fetchPage = jest.fn(() => Promise.resolve(page([], { total: 99, has_more: true })));
    const items = await fetchAllPages(fetchPage as Parameters<typeof fetchAllPages>[0]);
    expect(items).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test('stages.listAll drains the paginated endpoint into a flat list', async () => {
    const stage = validStage({ id: 1, stage_number: 1 });
    mockFetch.mockReturnValueOnce(jsonResponse(page([stage], { total: 1 })));
    const result = await stages.listAll('tok');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/stages?paginate=true');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(result).toEqual([stage]);
  });

  test('habits.listAll aggregates multiple pages', async () => {
    const habit = (id: number) => ({
      id,
      name: `h${id}`,
      icon: '🌱',
      start_date: '2026-01-01',
      energy_cost: 1,
      energy_return: 2,
      milestone_notifications: false,
      stage: 'beige',
      streak: 0,
      goals: [],
    });
    mockFetch
      .mockReturnValueOnce(jsonResponse(page([habit(1)], { total: 2, has_more: true })))
      .mockReturnValueOnce(jsonResponse(page([habit(2)], { total: 2, offset: 1 })));
    const result = await habits.listAll();
    expect(result.map((h) => h.id)).toEqual([1, 2]);
  });

  test('course.stageContentAll drains the stage content envelope', async () => {
    const item = validContentItem({ id: 7, title: 'Survival' });
    mockFetch.mockReturnValueOnce(jsonResponse(page([item])));
    const result = await course.stageContentAll(1, 'tok');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/course/stages/1/content?paginate=true');
    expect(result).toEqual([item]);
  });

  test('practices.listAll forwards include_mine and returns validated items', async () => {
    const valid = validPractice();
    mockFetch.mockReturnValueOnce(jsonResponse(page([valid])));
    const result = await practices.listAll({ stageNumber: 3, includeMine: true });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('stage_number=3');
    expect(url).toContain('include_mine=true');
    expect(url).toContain('paginate=true');
    expect(result).toEqual([valid]);
  });

  test('practices.listAll rejects a page with a malformed item (drift fails loud)', async () => {
    // Per-item validation now lives in the Page schema, so a bad row rejects the
    // whole page rather than being silently filtered (audit-contracts-04).
    mockFetch.mockReturnValueOnce(jsonResponse(page([validPractice(), { bogus: true }])));
    await expect(practices.listAll({ stageNumber: 3 })).rejects.toThrow(ApiValidationError);
  });
});
