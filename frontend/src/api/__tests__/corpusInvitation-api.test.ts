/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, corpusInvitation } from '../index';
import type { CorpusInvitation } from '../index';

/**
 * The client half of the corpus-invitation wire (#2407).
 *
 * Three things are worth a test rather than a type. ``offer`` is validated at
 * the edge, so a drifted field raises ``ApiValidationError`` instead of
 * rendering a note nobody decided to show. The decline carries its one
 * required boolean under the backend's name. And the decline is sent exactly
 * once: a "do not ask again" whose response was lost is a decision the person
 * made, and re-sending it is harmless, but a retry loop on a declinable note
 * is how a quiet surface becomes a chatty one.
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

const OFFERED: CorpusInvitation = { offer: true, dismissed_at: null, do_not_ask_again: false };
const SET_ASIDE: CorpusInvitation = {
  offer: false,
  dismissed_at: '2026-09-07T12:00:00Z',
  do_not_ask_again: false,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('corpusInvitation.status', () => {
  test('GETs /corpus/invitation with no trailing slash', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(OFFERED));

    const result = await corpusInvitation.status('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/invitation');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result).toEqual(OFFERED);
  });

  test('keeps a never-dismissed account as null rather than rejecting it', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(OFFERED));

    const result = await corpusInvitation.status('tok');

    expect(result.dismissed_at).toBeNull();
  });

  test('raises ApiValidationError when offer arrives as something other than a boolean', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ offer: 'yes', dismissed_at: null, do_not_ask_again: false }),
    );

    const err = await corpusInvitation.status('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});

describe('corpusInvitation.dismiss', () => {
  test('PUTs the one required boolean under the backend name', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...SET_ASIDE, do_not_ask_again: true }));

    const state = await corpusInvitation.dismiss(true, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/invitation');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ do_not_ask_again: true });
    expect(state.do_not_ask_again).toBe(true);
  });

  test('sends a plain "not now" as the same verb with false', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(SET_ASIDE));

    const state = await corpusInvitation.dismiss(false, 'tok');

    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({
      do_not_ask_again: false,
    });
    expect(state.dismissed_at).toBe('2026-09-07T12:00:00Z');
  });

  test('is attempted exactly once, surfacing a 500 rather than retrying it', async () => {
    mockFetch.mockReturnValue(jsonResponse({ detail: 'boom' }, 500));

    const err = await corpusInvitation.dismiss(false, 'tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
