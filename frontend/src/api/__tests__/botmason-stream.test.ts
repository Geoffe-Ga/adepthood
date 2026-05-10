/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import {
  ApiError,
  botmason,
  LLM_API_KEY_HEADER,
  setLlmApiKeyGetter,
  setTokenGetter,
  StreamingUnsupportedError,
} from '../index';

// Mock global fetch — every test installs its own response stream.
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

/**
 * Build a ``ReadableStream``-shaped mock that releases one chunk at a time.
 * Using a real stream keeps the test honest: the parser must cope with
 * split-across-chunk frames exactly as it would in production.
 */
function streamResponse(frames: string[], status = 200): Promise<Response> {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader: () => ({
      read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (i >= frames.length) return Promise.resolve({ done: true });
        const frame = frames[i++];
        return Promise.resolve({ done: false, value: encoder.encode(frame) });
      },
    }),
  };
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    body,
    // ``json`` is only used by the error path; streaming success tests
    // never reach it.
    json: () => Promise.resolve({}),
  } as unknown as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
  setTokenGetter(() => 'jwt');
});

afterEach(() => {
  setLlmApiKeyGetter(null);
  setTokenGetter(null);
});

const sampleComplete = {
  response: 'Hello world',
  remaining_balance: 4,
  remaining_messages: 48,
  monthly_reset_date: '2026-05-01T00:00:00Z',
  bot_entry_id: 7,
};

describe('botmason.chatStream', () => {
  test('parses one SSE frame per read call and fires callbacks in order', async () => {
    const frames = [
      'event: chunk\ndata: {"text":"Hello "}\n\n',
      'event: chunk\ndata: {"text":"world"}\n\n',
      `event: complete\ndata: ${JSON.stringify(sampleComplete)}\n\n`,
    ];
    mockFetch.mockReturnValueOnce(streamResponse(frames));

    const events: Array<[string, unknown]> = [];
    await botmason.chatStream(
      { message: 'hi' },
      {
        onChunk: (t) => events.push(['chunk', t]),
        onComplete: (r) => events.push(['complete', r]),
        onStreamError: (e) => events.push(['error', e]),
      },
    );

    expect(events).toEqual([
      ['chunk', 'Hello '],
      ['chunk', 'world'],
      ['complete', sampleComplete],
    ]);
  });

  test('joins frames that arrive split across multiple reads', async () => {
    // Simulate a slow proxy that flushes in the middle of a frame.
    const frames = [
      'event: chunk\ndata: {"te',
      'xt":"Split"}\n\n',
      `event: complete\ndata: ${JSON.stringify(sampleComplete)}\n\n`,
    ];
    mockFetch.mockReturnValueOnce(streamResponse(frames));

    const texts: string[] = [];
    let done = false;
    await botmason.chatStream(
      { message: 'hi' },
      {
        onChunk: (t) => texts.push(t),
        onComplete: () => {
          done = true;
        },
        onStreamError: () => {
          /* unused in happy path */
        },
      },
    );

    expect(texts).toEqual(['Split']);
    expect(done).toBe(true);
  });

  test('delivers an error frame via onStreamError', async () => {
    const frames = ['event: error\ndata: {"status":502,"detail":"llm_provider_error"}\n\n'];
    mockFetch.mockReturnValueOnce(streamResponse(frames));

    const errors: Array<{ status: number; detail: string }> = [];
    await botmason.chatStream(
      { message: 'hi' },
      {
        onChunk: () => {
          /* unused */
        },
        onComplete: () => {
          /* unused */
        },
        onStreamError: (e) => errors.push(e),
      },
    );

    expect(errors).toEqual([{ status: 502, detail: 'llm_provider_error' }]);
  });

  test('raises ApiError on non-2xx response without starting the stream', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 402,
        json: () => Promise.resolve({ detail: 'insufficient_offerings' }),
      }),
    );

    await expect(
      botmason.chatStream(
        { message: 'hi' },
        { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test('raises StreamingUnsupportedError when the runtime has no readable body', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
      }),
    );

    await expect(
      botmason.chatStream(
        { message: 'hi' },
        { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
      ),
    ).rejects.toBeInstanceOf(StreamingUnsupportedError);
  });

  test('attaches the X-LLM-API-Key header when a getter is registered', async () => {
    setLlmApiKeyGetter(() => 'sk-byok');
    mockFetch.mockReturnValueOnce(
      streamResponse([`event: complete\ndata: ${JSON.stringify(sampleComplete)}\n\n`]),
    );

    await botmason.chatStream(
      { message: 'hi' },
      { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
    );

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers[LLM_API_KEY_HEADER]).toBe('sk-byok');
    expect(init.headers.Accept).toBe('text/event-stream');
  });

  test('emits onStreamError for a malformed JSON data line', async () => {
    // Malformed data lines are a provider bug, not a stream transport bug —
    // reporting via the error callback keeps the caller's retry UX consistent.
    const frames = ['event: chunk\ndata: {not json\n\n'];
    mockFetch.mockReturnValueOnce(streamResponse(frames));

    const errors: Array<{ status: number; detail: string }> = [];
    await botmason.chatStream(
      { message: 'hi' },
      {
        onChunk: jest.fn(),
        onComplete: jest.fn(),
        onStreamError: (e) => errors.push(e),
      },
    );

    expect(errors).toEqual([{ status: 502, detail: 'malformed_stream_frame' }]);
  });

  test('BUG-API-002: 401 triggers token refresh and retries the stream once', async () => {
    // First fetch hits the SSE endpoint and returns 401.
    // Second fetch is the /auth/refresh call.
    // Third fetch retries the SSE endpoint and succeeds.
    const refreshedToken = `${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(8)}`;
    mockFetch
      .mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ detail: 'unauthorized' }),
        }),
      )
      .mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ token: refreshedToken, user_id: 1 }),
        }),
      )
      .mockReturnValueOnce(
        streamResponse([`event: complete\ndata: ${JSON.stringify(sampleComplete)}\n\n`]),
      );

    const onComplete = jest.fn();
    await botmason.chatStream(
      { message: 'hi' },
      { onChunk: jest.fn(), onComplete, onStreamError: jest.fn() },
    );

    // Three fetches: original SSE 401, /auth/refresh, retry SSE.
    const expectedCallCount = 3;
    expect(mockFetch).toHaveBeenCalledTimes(expectedCallCount);
    const [, refreshInit] = mockFetch.mock.calls[1];
    expect(mockFetch.mock.calls[1][0]).toContain('/auth/refresh');
    expect(refreshInit.method).toBe('POST');
    // Retry SSE call must use the new token, not the stale one.
    const [, retryInit] = mockFetch.mock.calls[2];
    expect(retryInit.headers.Authorization).toBe(`Bearer ${refreshedToken}`);
    expect(onComplete).toHaveBeenCalledWith(sampleComplete);
  });

  test('BUG-API-002: refresh failure surfaces ApiError without re-querying the stream', async () => {
    // 401 on the SSE endpoint, then 401 on /auth/refresh too.
    mockFetch
      .mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ detail: 'unauthorized' }),
        }),
      )
      .mockReturnValueOnce(
        Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }),
      );

    await expect(
      botmason.chatStream(
        { message: 'hi' },
        { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
      ),
    ).rejects.toBeInstanceOf(ApiError);
    // Must not retry the stream when refresh failed.
    const expectedCallCount = 2;
    expect(mockFetch).toHaveBeenCalledTimes(expectedCallCount);
  });
});
