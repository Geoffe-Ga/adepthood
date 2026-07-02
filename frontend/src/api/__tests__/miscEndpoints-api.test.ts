/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, course, frequency, practiceShare, practices, prompts } from '../index';

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

describe('frequency.current', () => {
  const validFrequency = {
    stage_number: 3,
    color: 'Orange',
    aspect: 'Mind',
    practice_name: 'Box Breath',
    practice_id: 5,
    user_practice_id: 9,
    banner_text: 'You are in the Orange frequency.',
  };

  test('omits stage_number from the query string when not supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(validFrequency));

    await frequency.current();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/user-practices/current/frequency');
  });

  test('appends stage_number when an override is supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(validFrequency));

    const result = await frequency.current(3, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/user-practices/current/frequency?stage_number=3');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(result).toEqual(validFrequency);
  });

  test('raises ApiValidationError on a malformed banner payload', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...validFrequency, color: 5 }));

    await expect(frequency.current()).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('practices.get and practices.create', () => {
  const validPractice = {
    id: 4,
    stage_number: 2,
    name: 'Box Breath',
    description: 'desc',
    instructions: 'inst',
    default_duration_minutes: 5,
    approved: true,
  };

  test('practices.get fetches a single practice by id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(validPractice));

    const result = await practices.get(4, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/4');
    expect(result).toEqual(validPractice);
  });

  test('practices.create POSTs a new draft practice', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...validPractice, approved: false }, 201));

    const result = await practices.create({
      stage_number: 2,
      name: 'New Practice',
      description: 'desc',
      instructions: 'inst',
      default_duration_minutes: 5,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/');
    expect(init.method).toBe('POST');
    expect(result.approved).toBe(false);
  });
});

describe('course misc endpoints', () => {
  test('markRead POSTs the mark-read endpoint', async () => {
    const completion = { id: 1, user_id: 2, content_id: 9, completed_at: '2026-05-01T00:00:00Z' };
    mockFetch.mockReturnValueOnce(jsonResponse(completion));

    const result = await course.markRead(9, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/content/9/mark-read');
    expect(init.method).toBe('POST');
    expect(result).toEqual(completion);
  });

  test('stageProgress GETs the stage progress summary', async () => {
    const progress = { total_items: 5, read_items: 2, progress_percent: 40, next_unlock_day: 3 };
    mockFetch.mockReturnValueOnce(jsonResponse(progress));

    const result = await course.stageProgress(1, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/stages/1/progress');
    expect(result).toEqual(progress);
  });

  test('contentBody GETs the raw markdown body', async () => {
    const body = { title: 'Intro', content_type: 'essay', body_markdown: '# Hi' };
    mockFetch.mockReturnValueOnce(jsonResponse(body));

    const result = await course.contentBody(9, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/content/9/body');
    expect(result).toEqual(body);
  });

  test('siteResources GETs the always-available resource list', async () => {
    const resources = [{ slug: 'faq', title: 'FAQ', description: 'desc', url: 'https://x' }];
    mockFetch.mockReturnValueOnce(jsonResponse(resources));

    const result = await course.siteResources('tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/site-resources');
    expect(result).toEqual(resources);
  });

  test('siteResourceBody GETs a single resource body by slug', async () => {
    const body = { title: 'FAQ', content_type: 'resource', body_markdown: '# FAQ' };
    mockFetch.mockReturnValueOnce(jsonResponse(body));

    const result = await course.siteResourceBody('faq', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/course/site-resources/faq/body');
    expect(result).toEqual(body);
  });
});

describe('prompts client', () => {
  test('current GETs the active weekly prompt', async () => {
    const prompt = {
      week_number: 3,
      question: 'What surprised you?',
      has_responded: false,
      response: null,
      timestamp: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(prompt));

    const result = await prompts.current('tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/prompts/current');
    expect(result).toEqual(prompt);
  });

  test('respond POSTs the free-text answer for a given week', async () => {
    const prompt = {
      week_number: 3,
      question: 'What surprised you?',
      has_responded: true,
      response: 'Everything.',
      timestamp: '2026-05-01T00:00:00Z',
    };
    mockFetch.mockReturnValueOnce(jsonResponse(prompt));

    const result = await prompts.respond(3, 'Everything.', 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/prompts/3/respond');
    expect(JSON.parse(init.body)).toEqual({ response: 'Everything.' });
    expect(result.has_responded).toBe(true);
  });

  test('history omits query params when none are supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: null, has_more: false }));

    await prompts.history();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/prompts/history');
  });

  test('history appends limit and offset when supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ items: [], total: 0, has_more: false }));

    await prompts.history({ limit: 10, offset: 5 }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/prompts/history?limit=10&offset=5');
  });
});

describe('practiceShare client', () => {
  test('create mints a share link with the default empty payload', async () => {
    const link = {
      id: 1,
      token: 'share-tok',
      practice_id: 4,
      created_at: '2026-05-01T00:00:00Z',
      expires_at: null,
      max_uses: null,
      use_count: 0,
      revoked_at: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(link, 201));

    const result = await practiceShare.create(4);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/4/share-link');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
    expect(result).toEqual(link);
  });

  test('list GETs the caller outstanding share links for a practice', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([]));

    const result = await practiceShare.list(4, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/4/share-links');
    expect(result).toEqual([]);
  });

  test('preview GETs a share link by token', async () => {
    const preview = {
      practice_id: 4,
      stage_number: 2,
      name: 'Box Breath',
      description: 'desc',
      instructions: 'inst',
      default_duration_minutes: 5,
      mode: 'meditation_timer',
      mode_config: {},
      created_by_display_name: 'friend',
      expires_at: null,
      max_uses: null,
      use_count: 1,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(preview));

    const result = await practiceShare.preview('share-tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/share/share-tok');
    expect(result).toEqual(preview);
  });

  test('import POSTs to redeem the share token', async () => {
    const imported = { practice_id: 4, stage_number: 2, name: 'Box Breath', approved: false };
    mockFetch.mockReturnValueOnce(jsonResponse(imported, 201));

    const result = await practiceShare.import('share-tok', 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/share/share-tok/import');
    expect(init.method).toBe('POST');
    expect(result).toEqual(imported);
  });

  test('revoke DELETEs a share link the caller minted', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(null, 204));

    await practiceShare.revoke(7, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/share-links/7');
    expect(init.method).toBe('DELETE');
  });

  test('preview URL-encodes a token containing reserved characters', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        practice_id: 1,
        stage_number: 1,
        name: 'X',
        description: '',
        instructions: '',
        default_duration_minutes: 5,
        mode: 'meditation_timer',
        mode_config: {},
        created_by_display_name: null,
        expires_at: null,
        max_uses: null,
        use_count: 0,
      }),
    );

    await practiceShare.preview('a/b c');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practices/share/a%2Fb%20c');
  });
});
