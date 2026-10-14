/* global describe, test, expect, beforeEach, jest */
import { course, ApiValidationError } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const TARGET = { content_id: 143, stage_number: 2, title: 'What is Purple?' };

describe('course.nextUnread', () => {
  test('GETs the next-unread endpoint with auth and returns the target', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(TARGET));

    const result = await course.nextUnread('test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/next-unread');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(TARGET);
  });

  test('returns null when the reader is caught up', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(null));

    await expect(course.nextUnread('test-token')).resolves.toBeNull();
  });

  test('rejects a malformed payload with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...TARGET, content_id: 'one' }));

    await expect(course.nextUnread('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a stage outside the curriculum', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...TARGET, stage_number: 11 }));

    await expect(course.nextUnread('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
