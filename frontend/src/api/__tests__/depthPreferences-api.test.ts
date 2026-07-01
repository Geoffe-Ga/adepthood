/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, depthPreferences } from '../index';
import type { DepthPreferences } from '../index';

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

const ALL_ON: DepthPreferences = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('depthPreferences.get', () => {
  test('GETs /depth-preferences (no trailing slash) and returns four booleans', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ALL_ON));
    const result = await depthPreferences.get('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/depth-preferences');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.enable_habits).toBe(true);
    expect(result.enable_practices).toBe(true);
    expect(result.enable_course).toBe(true);
    expect(result.enable_sangha).toBe(true);
  });

  test('surfaces a 401 as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    const err = await depthPreferences.get('bad-tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  test('rejects a malformed payload (non-boolean field) with ApiValidationError', async () => {
    // Schema must reject a string where boolean is required
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        enable_habits: 'yes',
        enable_practices: true,
        enable_course: true,
        enable_sangha: true,
      }),
    );
    await expect(depthPreferences.get('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('depthPreferences.update', () => {
  test('PATCHes /depth-preferences with a partial body and returns the full state', async () => {
    const fullResponse: DepthPreferences = {
      enable_habits: true,
      enable_practices: true,
      enable_course: false,
      enable_sangha: true,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(fullResponse));

    const result = await depthPreferences.update({ enable_course: false }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/depth-preferences');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enable_course: false });
    // Returns the server's FULL four-key response, not just the sent subset
    expect(result.enable_habits).toBe(true);
    expect(result.enable_practices).toBe(true);
    expect(result.enable_course).toBe(false);
    expect(result.enable_sangha).toBe(true);
  });

  test('partial in → full state out (multi-key subset)', async () => {
    const fullResponse: DepthPreferences = {
      enable_habits: false,
      enable_practices: false,
      enable_course: true,
      enable_sangha: true,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(fullResponse));

    const result = await depthPreferences.update(
      { enable_habits: false, enable_practices: false },
      'tok',
    );

    expect(result.enable_habits).toBe(false);
    expect(result.enable_practices).toBe(false);
    expect(result.enable_course).toBe(true);
    expect(result.enable_sangha).toBe(true);
  });

  test('surfaces a 422 (empty body rejection) as an ApiError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unprocessable_entity' }, 422));
    await expect(depthPreferences.update({}, 'tok')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
    });
  });
});
