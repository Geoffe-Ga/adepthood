/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// RED: the `reflections` client does not exist on `@/api` yet -- every case
// below fails with "reflections is not defined" / "is not a function" until
// the implementation-specialist adds `reflections.due` and
// `reflections.sources` to `@/api/index`.
// Harness note: this file uses the ambient jest globals (matching the sibling
// `promotions.test.ts`) rather than the `@jest/globals` import so that
// `global.fetch = mockFetch` and the `mock.calls[0]` tuple destructure below
// type-check cleanly. No assertion, URL, or payload expectation is changed.
import { reflections } from '../index';
import type { ReflectionDue, ReflectionSourceItem } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('reflections.due', () => {
  it('GETs /reflections/due and parses a non-null due window', async () => {
    const due: ReflectionDue = {
      level: 'week',
      scope_key: 'c1:w14',
      window_start: '2026-07-01T00:00:00Z',
      window_end: '2026-07-08T00:00:00Z',
      existing_entry_id: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse({ due }, 200));

    const result = await reflections.due('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/reflections/due');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.due).toEqual(due);
  });

  it('parses a null due window when nothing is currently due', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ due: null }, 200));

    const result = await reflections.due('tok');

    expect(result.due).toBeNull();
  });

  it('carries a set existing_entry_id through for a resumable in-progress reflection', async () => {
    const due: ReflectionDue = {
      level: 'stage',
      scope_key: 'c1:s1',
      window_start: '2026-06-01T00:00:00Z',
      window_end: '2026-07-01T00:00:00Z',
      existing_entry_id: 42,
    };
    mockFetch.mockReturnValueOnce(jsonResponse({ due }, 200));

    const result = await reflections.due('tok');

    expect(result.due?.existing_entry_id).toBe(42);
  });
});

describe('reflections.sources', () => {
  it('URL-encodes a colon-bearing scope_key onto the query string', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [] }, 200));

    await reflections.sources('stage', 'c1:s3', 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/reflections/sources?level=stage&scope_key=c1%3As3');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('parses entry and reflection source items with nested promoted quotes', async () => {
    const items: ReflectionSourceItem[] = [
      {
        kind: 'entry',
        id: 1,
        title: 'A quiet morning',
        timestamp: '2026-06-02T08:00:00Z',
        body: 'I noticed the willow again.',
        reflection_level: null,
        promoted_quotes: [
          {
            id: 90,
            anchor_start: 2,
            anchor_end: 19,
            anchor_text: 'noticed the willow',
            pending: true,
          },
        ],
      },
      {
        kind: 'reflection',
        id: 2,
        title: null,
        timestamp: '2026-06-15T08:00:00Z',
        body: 'A week of steady walking.',
        reflection_level: 'week',
        promoted_quotes: [],
      },
    ];
    mockFetch.mockReturnValueOnce(jsonResponse({ items }, 200));

    const result = await reflections.sources('stage', 'c1:s3', 'tok');

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      kind: 'entry',
      promoted_quotes: [{ anchor_text: 'noticed the willow' }],
    });
    expect(result.items[1]).toMatchObject({ kind: 'reflection', reflection_level: 'week' });
  });
});
