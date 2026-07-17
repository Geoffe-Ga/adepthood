/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { journal, TranscriptionError, TRANSCRIBE_TIMEOUT_MS, LLM_API_KEY_HEADER } from '../index';
import { transcribePageSchema } from '../schemas';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

// Distinctive fixture so a leak into logs or error messages is unmistakable.
const SENTINEL_PAYLOAD = 'ZZZZ_SENTINEL_PAYLOAD_ZZZZ';

type TranscriptionErrorInstance = InstanceType<typeof TranscriptionError>;

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((e: unknown) => e);
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('journal.transcribePage request shape', () => {
  test('POSTs the transcribe endpoint with a snake_case body and bearer auth', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ text: 'Today I felt...' }));
    await journal.transcribePage({ imageBase64: 'abc123', mediaType: 'image/png' }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/transcribe-page');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ image_base64: 'abc123', media_type: 'image/png' });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  test('resolves with the transcribed text on a 200', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ text: 'Today I felt...' }));
    const result = await journal.transcribePage(
      { imageBase64: 'abc123', mediaType: 'image/png' },
      'tok',
    );
    expect(result).toEqual({ text: 'Today I felt...' });
  });
});

describe('journal.transcribePage BYOK header', () => {
  test('attaches the header only when an api key is supplied', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ text: 'x' }));
    await journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok', 'sk-byok');
    expect(mockFetch.mock.calls[0][1].headers[LLM_API_KEY_HEADER]).toBe('sk-byok');

    mockFetch.mockReturnValueOnce(jsonResponse({ text: 'x' }));
    await journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok');
    expect(mockFetch.mock.calls[1][1].headers[LLM_API_KEY_HEADER]).toBeUndefined();
  });
});

describe('journal.transcribePage timeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('TRANSCRIBE_TIMEOUT_MS is 60 seconds, double the default fetch timeout', () => {
    expect(TRANSCRIBE_TIMEOUT_MS).toBe(60_000);
  });

  test('a stalled fetch survives the 30s default and times out at 60s', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const promise = journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok');
    promise.catch(() => {});

    await jest.advanceTimersByTimeAsync(30_000);
    const [, initAt30s] = mockFetch.mock.calls[0];
    expect(initAt30s.signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(30_000);
    const err = await captureError(promise);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionErrorInstance).kind).toBe('timeout');
    expect((err as TranscriptionErrorInstance).status).toBeNull();
  });
});

describe('journal.transcribePage error mapping', () => {
  const cases: Array<{ name: string; status: number; body: unknown; kind: string }> = [
    {
      name: '422 invalid_image',
      status: 422,
      body: { detail: 'invalid_image' },
      kind: 'invalid_image',
    },
    {
      name: '422 image_too_large',
      status: 422,
      body: { detail: 'image_too_large' },
      kind: 'image_too_large',
    },
    {
      name: '422 model_lacks_vision',
      status: 422,
      body: { detail: 'model_lacks_vision' },
      kind: 'model_lacks_vision',
    },
    {
      name: '422 pydantic array detail defaults to invalid_image',
      status: 422,
      body: { detail: [{ loc: ['body', 'image_base64'], msg: 'bad image', type: 'value_error' }] },
      kind: 'invalid_image',
    },
    {
      name: '402 insufficient_offerings maps to wallet_exhausted',
      status: 402,
      body: { detail: 'insufficient_offerings' },
      kind: 'wallet_exhausted',
    },
    {
      name: '402 llm_key_required is NOT wallet exhaustion',
      status: 402,
      body: { detail: 'llm_key_required' },
      kind: 'unknown',
    },
    {
      name: '429 slowapi error key maps to rate_limited',
      status: 429,
      body: { error: 'Rate limit exceeded: 20 per 1 minute' },
      kind: 'rate_limited',
    },
    {
      name: '502 llm_provider_error maps to provider_error',
      status: 502,
      body: { detail: 'llm_provider_error' },
      kind: 'provider_error',
    },
    {
      name: '400 user_not_found maps to unknown',
      status: 400,
      body: { detail: 'user_not_found' },
      kind: 'unknown',
    },
  ];

  test.each(cases)('$name', async ({ status, body, kind }) => {
    mockFetch.mockReturnValueOnce(jsonResponse(body, status));
    const err = await captureError(
      journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok'),
    );
    expect(err).toBeInstanceOf(TranscriptionError);
    const transcriptionErr = err as TranscriptionErrorInstance;
    expect(transcriptionErr.kind).toBe(kind);
    expect(transcriptionErr.status).toBe(status);
    expect(transcriptionErr.cause).toBeDefined();
  });

  test('does not retry a 502 (POST is non-idempotent)', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'llm_provider_error' }, 502));
    await captureError(
      journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok'),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('does not retry a 429 (POST is non-idempotent)', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ error: 'Rate limit exceeded: 20 per 1 minute' }, 429),
    );
    await captureError(
      journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok'),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('maps a network failure to kind network with a null status', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const err = await captureError(
      journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok'),
    );
    expect(err).toBeInstanceOf(TranscriptionError);
    const transcriptionErr = err as TranscriptionErrorInstance;
    expect(transcriptionErr.kind).toBe('network');
    expect(transcriptionErr.status).toBeNull();
  });
});

describe('transcribePageSchema', () => {
  test('parses a valid text payload', () => {
    expect(transcribePageSchema.parse({ text: 'x' })).toEqual({ text: 'x' });
  });

  test('rejects a payload missing the text field', () => {
    expect(transcribePageSchema.safeParse({ txt: 'x' }).success).toBe(false);
  });

  test('rejects a payload where text is the wrong type', () => {
    expect(transcribePageSchema.safeParse({ text: 123 }).success).toBe(false);
  });

  test('a 200 response that drifts from the schema rejects as kind unknown', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ notText: 1 }));
    const err = await captureError(
      journal.transcribePage({ imageBase64: 'abc', mediaType: 'image/png' }, 'tok'),
    );
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionErrorInstance).kind).toBe('unknown');
  });
});

describe('journal.transcribePage privacy', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function assertNoSecretLeak(spy: jest.SpyInstance): void {
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SENTINEL_PAYLOAD);
    }
  }

  test('a failed (502) call never logs the image payload or leaks it into the message', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'llm_provider_error' }, 502));
    const err = await captureError(
      journal.transcribePage({ imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png' }, 'tok'),
    );
    // A mapped transport error emits no console output at all, so the leak scan
    // would pass vacuously; assert silence explicitly to lock that in.
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect((err as TranscriptionErrorInstance).message).not.toContain(SENTINEL_PAYLOAD);
  });

  test('a schema-drift (200) call never logs the image payload or leaks it into the message', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ notText: 1 }));
    const err = await captureError(
      journal.transcribePage({ imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png' }, 'tok'),
    );
    assertNoSecretLeak(logSpy);
    assertNoSecretLeak(warnSpy);
    assertNoSecretLeak(errorSpy);
    expect((err as TranscriptionErrorInstance).message).not.toContain(SENTINEL_PAYLOAD);
  });
});
