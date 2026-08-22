/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, corpusConsent } from '../index';
import type { CorpusConsent } from '../index';

/**
 * The client half of the corpus-consent wire.
 *
 * Two things are worth a test rather than a type. The path carries the source,
 * so a wrapper that dropped it would silently decide about whichever source the
 * server defaulted to; and ``decided_at`` is null for a source nobody has been
 * asked about, which a schema that required a datetime would reject as
 * malformed — turning "we have not asked you yet" into an error screen.
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

const UNDECIDED: CorpusConsent = { source: 'journal', granted: false, decided_at: null };
const GRANTED: CorpusConsent = {
  source: 'journal',
  granted: true,
  decided_at: '2026-08-18T09:00:00Z',
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('corpusConsent.list', () => {
  test('GETs /corpus/consent and returns one state per source', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        sources: [
          UNDECIDED,
          { source: 'upload', granted: false, decided_at: null },
          { source: 'import', granted: false, decided_at: null },
        ],
      }),
    );

    const result = await corpusConsent.list('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/consent');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result.map((state) => state.source)).toEqual(['journal', 'upload', 'import']);
  });

  test('keeps a never-answered source as null rather than rejecting it', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ sources: [UNDECIDED] }));

    const [state] = await corpusConsent.list('tok');

    expect(state?.decided_at).toBeNull();
    expect(state?.granted).toBe(false);
  });

  test('raises ApiValidationError when a decision arrives as something other than a boolean', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ sources: [{ source: 'journal', granted: 'yes', decided_at: null }] }),
    );

    const err = await corpusConsent.list('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});

describe('corpusConsent.set', () => {
  test('PUTs the decision to the source named in the path', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(GRANTED));

    const state = await corpusConsent.set('journal', true, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/consent/journal');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ granted: true });
    expect(state.granted).toBe(true);
    expect(state.decided_at).toBe('2026-08-18T09:00:00Z');
  });

  test('sends a withdrawal as the same verb with granted false', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ source: 'journal', granted: false, decided_at: '2026-08-19T09:00:00Z' }),
    );

    const state = await corpusConsent.set('journal', false, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/consent/journal');
    expect(JSON.parse(init.body as string)).toEqual({ granted: false });
    expect(state.granted).toBe(false);
  });

  test('surfaces a 401 as an ApiError rather than a silent no-op', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    const err = await corpusConsent
      .set('journal', true, 'bad-tok')
      .catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
