/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, voiceDrafts } from '../index';
import type { VoiceDraft } from '../index';

/**
 * The client half of the Voice Drafts shelf (#2608).
 *
 * ``GET /journal/voice-drafts`` shipped with no caller at all, so these tests
 * pin the two things a wrapper can get wrong invisibly: the path it addresses
 * — the route is mounted without a trailing slash, and a slash costs a 307 that
 * downgrades the scheme behind the proxy — and whether the payload is checked
 * at the edge. ``essay`` and ``essay_generated_at`` are non-optional on this
 * route (the server's WHERE clause and its paired-nullability CHECK guarantee
 * it), so a null arriving there is contract drift and must raise rather than
 * render as a blank letter.
 */

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

function draft(overrides: Partial<VoiceDraft> = {}): VoiceDraft {
  return {
    marginalia_id: 4,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_text: 'I walk the same river twice',
    essay: 'A letter about returning.',
    essay_generated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function requestedUrl(): string {
  return String(mockFetch.mock.calls[0]?.[0]);
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('the Voice Drafts listing client', () => {
  test('addresses the slashless route and carries an explicit page window', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [draft()], total: 1, has_more: false }));

    const page = await voiceDrafts.list({ limit: 20, offset: 40 });

    const url = requestedUrl();
    expect(url.startsWith('http://test/journal/voice-drafts?')).toBe(true);
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(query.get('limit')).toBe('20');
    expect(query.get('offset')).toBe('40');
    expect(page.items).toEqual([draft()]);
    expect(page.has_more).toBe(false);
  });

  test('asks for the first page when the caller names no window', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: 0, has_more: false }));

    await voiceDrafts.list();

    const query = new URLSearchParams(requestedUrl().split('?')[1] ?? '');
    expect(query.get('offset')).toBe('0');
    expect(Number(query.get('limit'))).toBeGreaterThan(0);
  });

  test('reads an empty shelf as a page, not as a failure', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: 0, has_more: false }));

    await expect(voiceDrafts.list()).resolves.toEqual({ items: [], total: 0, has_more: false });
  });

  test('rejects a draft whose letter came back null instead of rendering a blank one', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        items: [{ ...draft(), essay: null, essay_generated_at: null }],
        total: 1,
        has_more: false,
      }),
    );

    await expect(voiceDrafts.list()).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a margin-note kind the app has no colour for', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ items: [{ ...draft(), kind: 'prophecy' }], total: 1, has_more: false }),
    );

    await expect(voiceDrafts.list()).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects an envelope missing its next-page flag', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [draft()], total: 1 }));

    await expect(voiceDrafts.list()).rejects.toBeInstanceOf(ApiValidationError);
  });
});
