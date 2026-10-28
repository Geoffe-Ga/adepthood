/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, corpus } from '../index';
import type { CorpusSweepEstimate, CorpusSweepResult } from '../index';

/**
 * The client half of the backlog sweep (#3497, #3498, #3499).
 *
 * ``GET /corpus/sweep`` is a count and ``POST /corpus/sweep`` is one bounded
 * pass. Three things are worth a test rather than a type: both shapes are
 * validated at the edge, the pass carries no body (the shipped contract takes
 * none), and the pass is sent exactly once -- it spends a provider call per
 * entry it reaches, and a lost response is something a person is told about,
 * not something the client quietly asks for again.
 */

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const HTTP_TOO_MANY_REQUESTS = 429;

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
  });
}

const ESTIMATE: CorpusSweepEstimate = { entries_pending: 412 };
const PASS: CorpusSweepResult = {
  entries_pending: 372,
  entries_sorted: 40,
  entries_remaining: 372,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('corpus.sweepEstimate', () => {
  test('GETs /corpus/sweep with no trailing slash and returns the count', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ESTIMATE));

    const result = await corpus.sweepEstimate('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/sweep');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result).toEqual(ESTIMATE);
  });

  test('raises ApiValidationError on a count that is not a non-negative integer', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ entries_pending: -1 }));

    const err = await corpus.sweepEstimate('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});

describe('corpus.sweep', () => {
  test('POSTs /corpus/sweep with no body and returns what the pass did', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(PASS));

    const result = await corpus.sweep('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/sweep');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(result).toEqual(PASS);
  });

  test('keeps a pass that sorted nothing, with a remainder, as a result rather than an error', async () => {
    const nothing: CorpusSweepResult = {
      entries_pending: 12,
      entries_sorted: 0,
      entries_remaining: 12,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(nothing));

    await expect(corpus.sweep('tok')).resolves.toEqual(nothing);
  });

  test('raises ApiValidationError when a count is missing', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ entries_pending: 3, entries_sorted: 0 }));

    const err = await corpus.sweep('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });

  test('sends a rate-limited pass exactly once and surfaces the 429', async () => {
    mockFetch.mockReturnValue(
      jsonResponse({ detail: 'rate_limit_exceeded' }, HTTP_TOO_MANY_REQUESTS),
    );

    const err = await corpus.sweep('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
