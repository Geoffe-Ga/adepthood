/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, LLM_API_KEY_HEADER, journal, resonance } from '../index';
import type { Marginalia, ResonanceResponse } from '../index';

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

function marginalia(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 1,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_start: 0,
    anchor_end: 5,
    anchor_text: 'I walk',
    note: 'A beginning.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function resonancePayload(): ResonanceResponse {
  return {
    marginalia: [marginalia()],
    suggestions: [],
    remaining_messages: 49,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('journal.update', () => {
  test('PATCHes the entry and serializes only the provided fields', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ id: 7, message: 'edited', sender: 'user' }));
    await journal.update(7, { title: 'New title' }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/7');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ title: 'New title' });
  });

  test('omits undefined fields from the body', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ id: 7, message: 'edited', sender: 'user' }));
    await journal.update(7, { message: 'edited', title: undefined }, 'tok');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ message: 'edited' });
    expect('title' in body).toBe(false);
  });
});

describe('resonance.generate', () => {
  test('POSTs the resonance endpoint and parses the response', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(resonancePayload(), 200));
    const result = await resonance.generate(7, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/7/resonance');
    expect(init.method).toBe('POST');
    expect(result.remaining_messages).toBe(49);
    expect(result.marginalia[0]!.kind).toBe('theme');
  });

  test('sends the BYOK header only when an api key is supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(resonancePayload(), 200));
    await resonance.generate(7, 'tok', 'sk-byok');
    expect(mockFetch.mock.calls[0][1].headers[LLM_API_KEY_HEADER]).toBe('sk-byok');

    mockFetch.mockReturnValueOnce(jsonResponse(resonancePayload(), 200));
    await resonance.generate(7, 'tok');
    expect(mockFetch.mock.calls[1][1].headers[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('surfaces a 402 as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'insufficient_offerings' }, 402));
    await expect(resonance.generate(7, 'tok')).rejects.toMatchObject({
      name: 'ApiError',
      status: 402,
      detail: 'insufficient_offerings',
    });
  });
});

describe('resonance.list', () => {
  test('GETs the marginalia list and parses items', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [marginalia(), marginalia({ id: 2 })] }));
    const result = await resonance.list(7, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/7/marginalia');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.items).toHaveLength(2);
  });

  test('surfaces a 404 as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'journal_entry_not_found' }, 404));
    const err = await resonance.list(7, 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe('resonance.essay', () => {
  test('POSTs the essay endpoint and parses the cached note', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(marginalia({ essay: 'A warm letter.' })));
    const result = await resonance.essay(1, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/marginalia/1/essay');
    expect(init.method).toBe('POST');
    expect(result.essay).toBe('A warm letter.');
  });

  test('surfaces a 404 (marginalia not found) as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'marginalia_not_found' }, 404));
    await expect(resonance.essay(999, 'tok')).rejects.toMatchObject({
      status: 404,
      detail: 'marginalia_not_found',
    });
  });
});
