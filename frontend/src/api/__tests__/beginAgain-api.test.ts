/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, stages } from '../index';
import type { StageProgressRecord } from '../index';

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

const VALID_RECORD: StageProgressRecord = {
  id: 1,
  user_id: 42,
  current_stage: 1,
  completed_stages: [],
  cycle_number: 2,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('stages.beginAgain', () => {
  test('POSTs to /stages/begin-again (exact path, no trailing slash)', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(VALID_RECORD));
    await stages.beginAgain();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/stages/begin-again');
    expect(init.method).toBe('POST');
  });

  test('returns a parsed StageProgressRecord with cycle_number', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(VALID_RECORD));
    const result = await stages.beginAgain();

    expect(result.cycle_number).toBe(2);
    expect(result.current_stage).toBe(1);
    expect(result.id).toBe(1);
    expect(result.user_id).toBe(42);
    expect(result.completed_stages).toEqual([]);
  });

  test('cycle_number increments: cycle 3 response parses correctly', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...VALID_RECORD, cycle_number: 3 }));
    const result = await stages.beginAgain();
    expect(result.cycle_number).toBe(3);
  });

  test('rejects a non-number cycle_number with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...VALID_RECORD, cycle_number: 'not-a-number' }));
    await expect(stages.beginAgain()).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a missing id field with ApiValidationError', async () => {
    const { id: _omit, ...withoutId } = VALID_RECORD;
    void _omit;
    mockFetch.mockReturnValueOnce(jsonResponse(withoutId));
    await expect(stages.beginAgain()).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a non-array completed_stages with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...VALID_RECORD, completed_stages: 'nope' }));
    await expect(stages.beginAgain()).rejects.toBeInstanceOf(ApiValidationError);
  });
});
