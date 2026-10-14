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

const TARGET = {
  kind: 'chapter',
  slug: null,
  content_id: 143,
  stage_number: 2,
  title: 'What is Purple?',
};

const RESOURCE_TARGET = {
  kind: 'resource',
  slug: 'liminal-creep',
  content_id: null,
  stage_number: null,
  title: 'Who Benefits?',
};

describe('course.nextUnread', () => {
  test('GETs the next-unread endpoint with auth and returns the target', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(TARGET));

    const result = await course.nextUnread('test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/next-unread');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(TARGET);
  });

  test('accepts a Start Here resource target keyed by slug', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(RESOURCE_TARGET));

    await expect(course.nextUnread('test-token')).resolves.toEqual(RESOURCE_TARGET);
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

  test('rejects an unknown kind', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...TARGET, kind: 'stage' }));

    await expect(course.nextUnread('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a chapter target with no content_id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...TARGET, content_id: null }));

    await expect(course.nextUnread('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a chapter target with no stage_number', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...TARGET, stage_number: null }));

    await expect(course.nextUnread('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a resource target with no slug', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...RESOURCE_TARGET, slug: null }));

    await expect(course.nextUnread('test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('course.markResourceRead', () => {
  test('POSTs the resource mark-read endpoint for the slug', async () => {
    const completion = { id: 7, slug: 'liminal-creep', completed_at: '2026-10-14T00:00:00Z' };
    mockFetch.mockReturnValueOnce(jsonResponse(completion));

    const result = await course.markResourceRead('liminal-creep', 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/site-resources/liminal-creep/mark-read');
    expect(init.method).toBe('POST');
    expect(result).toEqual(completion);
  });
});
