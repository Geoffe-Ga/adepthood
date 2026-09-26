/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */

/**
 * RED tests for the ``promotions`` API client (select-a-span -> promote-quote).
 *
 * ``promotions`` does not exist on ``@/api`` yet -- this file fails with
 * ``TypeError: promotions is undefined`` / ``is not a function`` until the
 * implementation-specialist adds the client to ``@/api/index``.
 */
import { ApiError, ApiValidationError, promotions } from '../index';
import type { PromotedQuote } from '../index';

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

function quote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 1,
    source_entry_id: 7,
    anchor_start: 2,
    anchor_end: 19,
    anchor_text: 'went for a run to',
    pending: true,
    stale: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('promotions.create', () => {
  test('POSTs the anchor offsets to /journal/{id}/promote and parses the 201 quote', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(quote(), 201));
    const result = await promotions.create(7, { anchor_start: 2, anchor_end: 19 }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/7/promote');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ anchor_start: 2, anchor_end: 19 });
    expect(result.id).toBe(1);
    expect(result.pending).toBe(true);
    expect(result.anchor_text).toBe('went for a run to');
  });

  test('surfaces a 422 anchor_out_of_range as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'anchor_out_of_range' }, 422));
    const err = await promotions
      .create(7, { anchor_start: 0, anchor_end: 9999 }, 'tok')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).detail).toBe('anchor_out_of_range');
  });

  test('surfaces a 422 quote_too_long as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'quote_too_long' }, 422));
    await expect(
      promotions.create(7, { anchor_start: 0, anchor_end: 5000 }, 'tok'),
    ).rejects.toMatchObject({ status: 422, detail: 'quote_too_long' });
  });
});

describe('promotions.remove', () => {
  test('DELETEs /promotions/{id} and resolves to void on 204', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(undefined, 204));
    const result = await promotions.remove(55, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/promotions/55');
    expect(init.method).toBe('DELETE');
    expect(result).toBeUndefined();
  });

  test('surfaces a 404 (missing or foreign quote) as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'promotion_not_found' }, 404));
    await expect(promotions.remove(55, 'tok')).rejects.toMatchObject({ status: 404 });
  });
});

describe('promotions.setIncluded', () => {
  test('PATCHes /promotions/{id} with the target entry id, folding the quote in', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(quote({ id: 55, pending: false }), 200));
    const result = await promotions.setIncluded(55, 12, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/promotions/55');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ included_in_entry_id: 12 });
    expect(result.pending).toBe(false);
  });

  test('PATCHes null to return a folded quote to pending', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(quote({ id: 55, pending: true }), 200));
    const result = await promotions.setIncluded(55, null, 'tok');

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ included_in_entry_id: null });
    expect(result.pending).toBe(true);
  });
});

describe('promotions.list', () => {
  test('GETs /journal/{id}/promotions and resolves to the schema-parsed array', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse([quote({ id: 1, anchor_start: 1 }), quote({ id: 2, anchor_start: 9 })], 200),
    );
    const result = await promotions.list(7, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/7/promotions');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result).toEqual([
      expect.objectContaining({ id: 1, anchor_start: 1 }),
      expect.objectContaining({ id: 2, anchor_start: 9 }),
    ]);
  });

  test('rejects a malformed row (anchor_start as a string) via zod', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse([{ ...quote(), anchor_start: 'not-a-number' }], 200),
    );
    await expect(promotions.list(7, 'tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('promotions.listAll', () => {
  const listItem = {
    ...quote({ id: 4, pending: false }),
    source_title: 'Rain',
    source_timestamp: '2026-03-01T09:00:00Z',
    included_in_entry_id: 12,
    included_in_title: 'The windy week',
    created_at: '2026-03-02T09:00:00Z',
  };

  test('GETs /promotions with no query string when called bare', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: 0, has_more: false }));
    await promotions.listAll({}, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/promotions');
    expect(init.method ?? 'GET').toBe('GET');
  });

  test('sends status, limit and offset as the exact query string', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: 0, has_more: false }));
    await promotions.listAll({ status: 'included', limit: 50, offset: 100 }, 'tok');

    expect(mockFetch.mock.calls[0][0]).toBe(
      'http://test/promotions?status=included&limit=50&offset=100',
    );
  });

  test('keeps an offset of zero rather than dropping it', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: 0, has_more: false }));
    await promotions.listAll({ status: 'pending', offset: 0 });

    expect(mockFetch.mock.calls[0][0]).toBe('http://test/promotions?status=pending&offset=0');
  });

  test('parses a page of list items with their sources', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [listItem], total: 3, has_more: true }));
    const page = await promotions.listAll();

    expect(page.total).toBe(3);
    expect(page.has_more).toBe(true);
    expect(page.items[0]).toEqual(listItem);
  });

  test('rejects an item missing source_timestamp', async () => {
    const broken: Record<string, unknown> = { ...listItem };
    delete broken.source_timestamp;
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [broken], total: 1, has_more: false }));

    await expect(promotions.listAll()).rejects.toBeInstanceOf(ApiValidationError);
  });
});
