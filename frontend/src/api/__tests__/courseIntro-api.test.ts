/* eslint-env jest */
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

const INTRO = {
  stage: 1,
  id: 'beige-intro',
  slug: 'beige-introduction',
  title: 'Welcome to Beige',
  summary: 'What Beige is about.',
};

const INTRO_BODY = {
  title: 'Welcome to Beige',
  content_type: 'introduction',
  body_markdown: '# Welcome to Beige\n\nintro body.\n',
};

describe('course stage-intro client', () => {
  test('stageIntro GETs the stage-intro endpoint with auth', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(INTRO));

    const result = await course.stageIntro(1, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/stages/1/intro');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(INTRO);
  });

  test('stageIntroBody GETs the stage-intro body endpoint with auth', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(INTRO_BODY));

    const result = await course.stageIntroBody(2, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/stages/2/intro/body');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(INTRO_BODY);
  });

  test('stageIntro rejects a malformed payload with ApiValidationError', async () => {
    // stage as a string violates the Zod schema → validated at the boundary.
    mockFetch.mockReturnValueOnce(
      jsonResponse({ stage: 'one', id: 'x', slug: 'x', title: 'x', summary: null }),
    );

    await expect(course.stageIntro(1, 'test-token')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
