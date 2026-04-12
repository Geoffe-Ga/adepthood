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
});
