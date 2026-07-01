/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, wheel } from '../index';
import type { WheelBalance } from '../index';

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

/** Minimal valid wheel payload with 10 aspects in canonical stage order. */
const VALID_WHEEL: WheelBalance = {
  aspects: [
    { stage_number: 1, aspect: 'Agency', fullness: 0.1 },
    { stage_number: 2, aspect: 'Receptivity', fullness: 0.2 },
    { stage_number: 3, aspect: 'Self-Interest', fullness: 0.85 },
    { stage_number: 4, aspect: 'Community', fullness: 0.0 },
    { stage_number: 5, aspect: 'Intellectual', fullness: 0.5 },
    { stage_number: 6, aspect: 'Embodied', fullness: 0.6 },
    { stage_number: 7, aspect: 'Systems', fullness: 0.3 },
    { stage_number: 8, aspect: 'Wisdom', fullness: 0.7 },
    { stage_number: 9, aspect: 'Being', fullness: 0.9 },
    { stage_number: 10, aspect: 'Awareness', fullness: 1.0 },
  ],
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('wheel.get', () => {
  test('GETs /stages/wheel (no trailing slash) and returns parsed aspects', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(VALID_WHEEL));
    const result = await wheel.get('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/stages/wheel');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.aspects).toHaveLength(10);
    expect(result.aspects[2]?.stage_number).toBe(3);
    expect(result.aspects[2]?.fullness).toBe(0.85);
    expect(result.aspects[2]?.aspect).toBe('Self-Interest');
  });

  test('surfaces a 401 as ApiError with status 401', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    const err = await wheel.get('bad-tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  test('rejects malformed payload (non-number fullness) with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        aspects: [{ stage_number: 1, aspect: 'Agency', fullness: 'x' }],
      }),
    );
    await expect(wheel.get('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
