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
  writing_session_habit_id: null,
  practice_session_habit_id: null,
};

const LINKED_HABIT_ID = 42;

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

describe('uiFlags writing_session_habit_id', () => {
  test('a payload from before the link existed parses, with the link null', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ has_seen_welcome: true, energy_scaffolding_archived: false }),
    );
    const result = await uiFlags.get('tok');
    expect(result.writing_session_habit_id).toBeNull();
  });

  test('a linked habit id parses through as a number', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        has_seen_welcome: true,
        energy_scaffolding_archived: false,
        writing_session_habit_id: LINKED_HABIT_ID,
        practice_session_habit_id: null,
      }),
    );
    const result = await uiFlags.get('tok');
    expect(result.writing_session_habit_id).toBe(LINKED_HABIT_ID);
  });

  test.each([['42'], [-1], [0], [1.5]])(
    'rejects a link that no habit id can be (%p) with ApiValidationError',
    async (bad) => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          has_seen_welcome: true,
          energy_scaffolding_archived: false,
          writing_session_habit_id: bad,
          practice_session_habit_id: null,
        }),
      );
      await expect(uiFlags.get('tok')).rejects.toBeInstanceOf(ApiValidationError);
    },
  );

  test('update sends an explicit null verbatim, which is how the link is cleared', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ALL_SEEN));
    await uiFlags.update({ writing_session_habit_id: null }, 'tok');
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ writing_session_habit_id: null });
  });
});

describe('uiFlags practice_session_habit_id', () => {
  test('a payload without the practice link types as unlinked, with the field absent', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ALL_SEEN));
    const result = await uiFlags.get('tok');
    expect(result.practice_session_habit_id ?? null).toBeNull();
  });

  test('update sends the practice link verbatim, and an explicit null to clear it', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ALL_SEEN));
    await uiFlags.update({ practice_session_habit_id: LINKED_HABIT_ID }, 'tok');
    mockFetch.mockReturnValueOnce(jsonResponse(ALL_SEEN));
    await uiFlags.update({ practice_session_habit_id: null }, 'tok');

    const [, first] = mockFetch.mock.calls[0];
    const [, second] = mockFetch.mock.calls[1];
    expect(JSON.parse(first.body)).toEqual({ practice_session_habit_id: LINKED_HABIT_ID });
    expect(JSON.parse(second.body)).toEqual({ practice_session_habit_id: null });
  });
});

describe('uiFlags.update', () => {
  test('PATCHes /ui-flags with the partial body verbatim and returns the full echo', async () => {
    const fullResponse: UiFlags = {
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
      writing_session_habit_id: null,
      practice_session_habit_id: null,
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

describe('uiFlags practice_session_habit_id parses like the writing link', () => {
  test('a linked practice habit id parses through as a number', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        has_seen_welcome: true,
        energy_scaffolding_archived: false,
        writing_session_habit_id: null,
        practice_session_habit_id: LINKED_HABIT_ID,
      }),
    );
    const result = await uiFlags.get('tok');
    expect(result.practice_session_habit_id).toBe(LINKED_HABIT_ID);
  });

  test('a payload from before the practice link existed parses, with the link null', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        has_seen_welcome: true,
        energy_scaffolding_archived: false,
        writing_session_habit_id: LINKED_HABIT_ID,
        practice_session_habit_id: null,
      }),
    );
    const result = await uiFlags.get('tok');
    expect(result.practice_session_habit_id).toBeNull();
  });
});
