/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, IDEMPOTENCY_KEY_HEADER, completionSuggestions } from '../index';
import type { CompletionSuggestion } from '../index';

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

function suggestion(overrides: Partial<CompletionSuggestion> = {}): CompletionSuggestion {
  return {
    id: 1,
    journal_entry_id: 7,
    target_type: 'habit',
    goal_id: 3,
    user_practice_id: null,
    label: 'I went for a run',
    anchor_start: 0,
    anchor_end: 15,
    anchor_text: 'I went for a run',
    status: 'pending',
    accepted_at: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const checkIn = { streak: 4, milestones: [{ threshold: 3 }], reason_code: 'streak_incremented' };

beforeEach(() => {
  mockFetch.mockReset();
});

describe('completionSuggestions.list', () => {
  test('GETs the canonical /journal/{id}/suggestions URL (no 307)', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [suggestion(), suggestion({ id: 2 })] }));
    const result = await completionSuggestions.list(7, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/7/suggestions');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.items).toHaveLength(2);
  });

  test('surfaces a 404 as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'journal_entry_not_found' }, 404));
    const err = await completionSuggestions.list(7, 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe('completionSuggestions.accept', () => {
  test('POSTs the canonical accept URL with a deterministic idempotency key', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ suggestion: suggestion({ status: 'accepted' }), check_in: checkIn }),
    );
    const result = await completionSuggestions.accept(1, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/suggestions/1/accept');
    expect(init.method).toBe('POST');
    expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toBe('accept-suggestion:1');
    expect(result.suggestion.status).toBe('accepted');
    expect(result.check_in?.streak).toBe(4);
  });

  test('surfaces a 422 (practice accept) as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'practice_accept_not_supported' }, 422));
    await expect(completionSuggestions.accept(9, 'tok')).rejects.toMatchObject({
      status: 422,
      detail: 'practice_accept_not_supported',
    });
  });
});

describe('completionSuggestions.dismiss', () => {
  test('POSTs the canonical dismiss URL and parses the dismissed row', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(suggestion({ status: 'dismissed' })));
    const result = await completionSuggestions.dismiss(1, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/suggestions/1/dismiss');
    expect(init.method).toBe('POST');
    expect(result.status).toBe('dismissed');
  });
});
