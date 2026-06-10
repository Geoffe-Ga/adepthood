/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import {
  ApiError,
  botmason,
  LLM_API_KEY_HEADER,
  setLlmApiKeyGetter,
  setOnUnauthorized,
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

  test('BUG-API-011: parses CRLF-terminated frames (production servers behind nginx)', async () => {
    // A server that emits CRLF line endings + CRLF-CRLF frame terminators
    // used to silently drop every event because the parser keyed only on
    // ``"\n\n"`` and ``"\n"``.  This regression exercises the same
    // sample_complete payload but with CRLF framing throughout.
    const frames = [
      'event: chunk\r\ndata: {"text":"Hello "}\r\n\r\n',
      'event: chunk\r\ndata: {"text":"world"}\r\n\r\n',
      `event: complete\r\ndata: ${JSON.stringify(sampleComplete)}\r\n\r\n`,
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

  test('BUG-API-012: an aborted signal cancels the reader so the stream returns promptly', async () => {
    // Build a reader that would loop forever (server hung) so abort is the
    // only way out.  After ``signal.abort()`` we expect ``reader.cancel``
    // to fire and ``read()`` to resolve ``done: true`` so chatStream
    // returns instead of hanging the test.
    const cancelSpy = jest.fn();
    let resolveRead: (val: { done: boolean; value?: Uint8Array }) => void = () => {};
    const body = {
      getReader: () => ({
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            resolveRead = resolve;
          }),
        cancel: () => {
          cancelSpy();
          // Wake the pending ``read()`` so the loop exits.
          resolveRead({ done: true });
          return Promise.resolve();
        },
      }),
    };
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        status: 200,
        body,
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );

    const controller = new AbortController();
    const streamPromise = botmason.chatStream(
      { message: 'hi' },
      { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
      { signal: controller.signal },
    );
    // Wait for the reader to actually start reading so the abort listener
    // is attached before we fire the abort.  Multiple microtask flushes
    // because the chain is several ``await``s deep before
    // ``readChatStream`` installs its listener.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    controller.abort();
    await streamPromise;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test('BUG-API-014: a 401 error frame mid-stream fires the unauthorized callback', async () => {
    // The stream opens cleanly (200), but the server emits an
    // ``event: error`` frame with status 401 because the token was
    // revoked from another device.  The non-streaming path routes 401
    // through the global callback; the streaming path now does the same
    // so the AuthContext can react identically.
    const onUnauthorized = jest.fn();
    setOnUnauthorized(onUnauthorized);
    try {
      const frames = [
        `event: error\ndata: ${JSON.stringify({ status: 401, detail: 'unauthorized' })}\n\n`,
      ];
      mockFetch.mockReturnValueOnce(streamResponse(frames));

      const onStreamError = jest.fn();
      await botmason.chatStream(
        { message: 'hi' },
        { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError },
      );

      expect(onUnauthorized).toHaveBeenCalledWith('session_expired');
      // Caller-supplied onStreamError still fires so the UI can show a
      // mid-stream failure banner.
      expect(onStreamError).toHaveBeenCalledWith({ status: 401, detail: 'unauthorized' });
    } finally {
      setOnUnauthorized(null);
    }
  });

  test.each([
    ['session_expired', 'unauthorized', true],
    ['invalid_token', 'invalid_token', true],
    ['not_authenticated', 'unauthorized', false],
  ])(
    'a 401 SSE preamble fires onUnauthorized with %s (#272)',
    async (reason: string, detail: string, hadToken: boolean) => {
      // The classifier (classifyUnauthorizedDetail / reasonForUnauthorized)
      // is unit-tested in unauthorizedReason.test.ts; this closes the loop
      // for the STREAMING endpoint's pre-frame 401, which reuses the same
      // refresh-then-classify path as the request/response client.
      setTokenGetter(hadToken ? () => 'jwt' : () => null);
      const onUnauthorized = jest.fn();
      setOnUnauthorized(onUnauthorized);
      try {
        // Every fetch (SSE preamble, then /auth/refresh when a token
        // exists) answers 401 with the case's detail string.
        mockFetch.mockImplementation(() =>
          Promise.resolve({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ detail }),
          }),
        );

        await botmason
          .chatStream(
            { message: 'hi' },
            { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
          )
          .catch(() => {
            /* the rejected stream is asserted elsewhere; reason is the subject here */
          });

        expect(onUnauthorized).toHaveBeenCalledWith(reason);
      } finally {
        setOnUnauthorized(null);
      }
    },
  );

  test('BUG-API-002: refresh failure surfaces ApiError without re-querying the stream', async () => {
    // 401 on the SSE endpoint, then 401 on /auth/refresh too.
    // PR #297 review: assert the thrown ``error.detail`` carries the
    // server's actual detail string ("unauthorized"), not the generic
    // "Request failed" fallback that ``extractErrorDetail`` returns when
    // the body has been consumed.  This pins the contract that the
    // initial response body is read EXACTLY once.
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

    const error: unknown = await botmason
      .chatStream(
        { message: 'hi' },
        { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).detail).toBe('unauthorized');
    // Must not retry the stream when refresh failed.
    const expectedCallCount = 2;
    expect(mockFetch).toHaveBeenCalledTimes(expectedCallCount);
  });

  test('BUG-API-002: 401 + refresh fail does not double-read the response body', async () => {
    // PR #297 review: in production fetch, calling ``.json()`` on a
    // ``Response`` whose ``bodyUsed`` is true throws
    // ``TypeError: body used already``.  This test mimics that semantic
    // by throwing on a second read; the chatStream path MUST not trigger
    // the throw -- it must thread the parsed detail back from
    // ``retryStreamWithRefresh`` instead of re-reading.
    let bodyUsed = false;
    const initialRes = {
      ok: false,
      status: 401,
      json: () => {
        if (bodyUsed) return Promise.reject(new TypeError('body used already'));
        bodyUsed = true;
        return Promise.resolve({ detail: 'unauthorized' });
      },
    };
    mockFetch
      .mockReturnValueOnce(Promise.resolve(initialRes))
      .mockReturnValueOnce(
        Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }),
      );

    const error: unknown = await botmason
      .chatStream(
        { message: 'hi' },
        { onChunk: jest.fn(), onComplete: jest.fn(), onStreamError: jest.fn() },
      )
      .catch((e: unknown) => e);
    // Must surface ``ApiError`` with the real detail, not a TypeError.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toBe('unauthorized');
  });
});
