/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, uiFlags } from '../index';
import type { UiFlags } from '../index';

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

const ALL_SEEN: UiFlags = {
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('uiFlags.get', () => {
  test('GETs /ui-flags (no trailing slash) with the bearer token and returns the parsed body', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ALL_SEEN));
    const result = await uiFlags.get('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/ui-flags');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(result.has_seen_welcome).toBe(true);
    expect(result.energy_scaffolding_archived).toBe(false);
  });

  test('surfaces a 401 as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    const err = await uiFlags.get('bad-tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  test('rejects a malformed payload (non-boolean field) with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        has_seen_welcome: 'yes',
        energy_scaffolding_archived: false,
      }),
    );
    await expect(uiFlags.get('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('strips unknown keys from the response', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        has_seen_welcome: true,
        energy_scaffolding_archived: false,
        unexpected_field: 'should be stripped',
      }),
    );
    const result = await uiFlags.get('tok');
    expect(result).toEqual(ALL_SEEN);
    expect((result as Record<string, unknown>).unexpected_field).toBeUndefined();
  });
});

describe('uiFlags.update', () => {
  test('PATCHes /ui-flags with the partial body verbatim and returns the full echo', async () => {
    const fullResponse: UiFlags = {
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(fullResponse));

    const result = await uiFlags.update({ has_seen_welcome: true }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/ui-flags');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ has_seen_welcome: true });
    expect(result.has_seen_welcome).toBe(true);
    expect(result.energy_scaffolding_archived).toBe(false);
  });

  test('surfaces a 422 (empty body rejection) as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unprocessable_entity' }, 422));
    await expect(uiFlags.update({}, 'tok')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
    });
  });
});
