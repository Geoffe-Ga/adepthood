/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import {
  practices,
  practiceSessions,
  goalGroups,
  stages,
  userPractices,
  course,
  ApiValidationError,
} from '../index';

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

describe('paginated list endpoints (issue #221 — Page envelope)', () => {
  test('practices.listPaginated opts into the envelope and forwards stage_number', async () => {
    const envelope = page([{ id: 1, stage_number: 3, name: 'Box Breath' }]);
    mockFetch.mockReturnValueOnce(jsonResponse(envelope));

    const result = await practices.listPaginated({ stageNumber: 3 }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/?paginate=true&stage_number=3');
    expect(init.method).toBeUndefined(); // GET
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(result).toEqual(envelope);
  });

  test('practices.listPaginated forwards limit and offset when supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(page([], { total: 120, has_more: true })));

    await practices.listPaginated({ stageNumber: 2, limit: 50, offset: 50 }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/?paginate=true&stage_number=2&limit=50&offset=50');
  });

  test('practiceSessions.listPaginated forwards user_practice_id', async () => {
    const envelope = page([{ id: 9, user_practice_id: 5 }]);
    mockFetch.mockReturnValueOnce(jsonResponse(envelope));

    const result = await practiceSessions.listPaginated({ userPracticeId: 5 }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-sessions/?paginate=true&user_practice_id=5');
    expect(result.items).toHaveLength(1);
  });

  test('goalGroups.listPaginated hits /goal-groups/ with the envelope flag', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(page([{ id: 1, name: 'Morning' }])));

    await goalGroups.listPaginated({ limit: 10 }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/goal-groups/?paginate=true&limit=10');
  });

  test('stages.listPaginated hits /stages (no trailing slash) with the envelope flag', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(page([{ stage_number: 1, name: 'Beige' }])));

    await stages.listPaginated({}, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/stages?paginate=true');
  });

  test('userPractices.listPaginated hits /user-practices/ with the envelope flag', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(page([{ id: 1, practice_id: 2 }])));

    await userPractices.listPaginated({ offset: 0 }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/user-practices/?paginate=true&offset=0');
  });

  test('course.stageContentPaginated targets the stage content path with the envelope flag', async () => {
    const envelope = page([{ id: 1, title: 'Intro', release_day: 0 }], {
      total: 3,
      has_more: true,
    });
    mockFetch.mockReturnValueOnce(jsonResponse(envelope));

    const result = await course.stageContentPaginated(3, { limit: 50 }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/stages/3/content?paginate=true&limit=50');
    expect(result.has_more).toBe(true);
    expect(result.total).toBe(3);
  });

  test('a malformed envelope (missing has_more) raises ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }), // no has_more
    );

    await expect(stages.listPaginated({}, 'tok')).rejects.toThrow(ApiValidationError);
  });

  test('a non-array items field raises ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ items: 'nope', total: 0, limit: 50, offset: 0, has_more: false }),
    );

    await expect(goalGroups.listPaginated({}, 'tok')).rejects.toThrow(ApiValidationError);
  });
});
