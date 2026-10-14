/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import {
  journal,
  TranscriptionError,
  TRANSCRIBE_TIMEOUT_MS,
  LLM_API_KEY_HEADER,
  setLlmApiKeyGetter,
} from '../index';
import { transcribePageSchema } from '../schemas';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

// A development build may send a keyless page to its local server, whose stub
// test seam can answer it; a production build cannot. Most cases here drive the
// server path, so it is on unless a test switches it off.
let mockKeylessReachesServer = true;
jest.mock('@/config', () => ({
  API_BASE_URL: 'http://test',
  get KEYLESS_PAGE_READ_REACHES_SERVER() {
    return mockKeylessReachesServer;
  },
}));

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
    await journal.transcribePage(
      { imageBase64: 'abc123', mediaType: 'image/png', classification: 'personal' },
      'tok',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/transcribe-page');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      image_base64: 'abc123',
      media_type: 'image/png',
      classification: 'personal',
    });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  test('resolves with the transcribed text on a 200', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ text: 'Today I felt...' }));
    const result = await journal.transcribePage(
      { imageBase64: 'abc123', mediaType: 'image/png', classification: 'personal' },
      'tok',
    );
    expect(result).toEqual({ text: 'Today I felt...' });
  });
});

const OPENAI_KEY = 'sk-device-openai-0123456789abcdef'; // pragma: allowlist secret
const ANTHROPIC_KEY = 'sk-ant-device-anthropic-0123456789'; // pragma: allowlist secret
const ADMISSION_URL = 'http://test/journal/transcribe-page/direct-admission';
const PAGE_URL = 'http://test/journal/transcribe-page';

function admitted() {
  return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
}

function openaiReply(text: string) {
  return jsonResponse({ choices: [{ message: { content: text } }] });
}

/** Every request this test sent to Adepthood's own API, as the wire saw it. */
function requestsToAdepthood(): string[] {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).startsWith('http://test/'))
    .map(([url, init]) => JSON.stringify({ url, init }));
}

describe("journal.transcribePage with the writer's own key (ADR 0009 phase (a), #3067)", () => {
  afterEach(() => {
    setLlmApiKeyGetter(null);
  });

  test.each([
    ['an explicit key', OPENAI_KEY, 'https://api.openai.com/v1/chat/completions'],
    ['an Anthropic key', ANTHROPIC_KEY, 'https://api.anthropic.com/v1/messages'],
  ])(
    '%s: asks admission, then sends the page from the device to the vendor',
    async (_n, key, vendorUrl) => {
      mockFetch.mockReturnValueOnce(admitted());
      mockFetch.mockReturnValueOnce(
        key === ANTHROPIC_KEY
          ? jsonResponse({ content: [{ type: 'text', text: 'Dear diary' }] })
          : openaiReply('Dear diary'),
      );

      const result = await journal.transcribePage(
        { imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png', classification: 'personal' },
        'tok',
        key,
      );

      expect(result).toEqual({ text: 'Dear diary' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [admissionUrl, admissionInit] = mockFetch.mock.calls[0];
      expect(admissionUrl).toBe(ADMISSION_URL);
      expect(admissionInit.method).toBe('POST');
      // The admission carries the page's declared tier and nothing else (#3059 AC15).
      expect(JSON.parse(admissionInit.body)).toEqual({ classification: 'personal' });
      expect(admissionInit.headers.Authorization).toBe('Bearer tok');
      expect(mockFetch.mock.calls[1][0]).toBe(vendorUrl);
      expect(mockFetch.mock.calls[1][1].body).toContain(SENTINEL_PAYLOAD);
    },
  );

  test('the key registered by the BYOK provider is used when none is passed', async () => {
    setLlmApiKeyGetter(() => OPENAI_KEY);
    mockFetch.mockReturnValueOnce(admitted());
    mockFetch.mockReturnValueOnce(openaiReply('page'));

    await journal.transcribePage(
      { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
      'tok',
    );

    expect(mockFetch.mock.calls[0][0]).toBe(ADMISSION_URL);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  test('nothing sent to Adepthood carries the key, its header, or the page', async () => {
    mockFetch.mockReturnValueOnce(admitted());
    mockFetch.mockReturnValueOnce(openaiReply('page'));

    await journal.transcribePage(
      { imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png', classification: 'personal' },
      'tok',
      OPENAI_KEY,
    );

    const sent = requestsToAdepthood();
    expect(sent).toHaveLength(1);
    for (const request of sent) {
      expect(request).not.toContain(OPENAI_KEY);
      expect(request).not.toContain(SENTINEL_PAYLOAD);
      expect(request.toLowerCase()).not.toContain(LLM_API_KEY_HEADER.toLowerCase());
    }
    expect(mockFetch.mock.calls.some(([url]) => url === PAGE_URL)).toBe(false);
  });

  test('a suspended deployment stops the page before it leaves the device', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'ai_suspended' }, 503));

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
        OPENAI_KEY,
      ),
    )) as TranscriptionErrorInstance;

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.kind).toBe('unknown');
    expect(err.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a tier the server will not admit stops the page before it leaves the device', async () => {
    // Defence in depth behind the capture screen's own Intimate gate (#1882):
    // the server refuses the declared tier, and the vendor is never dialled.
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'tier_refused' }, 403));

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png', classification: 'intimate' },
        'tok',
        OPENAI_KEY,
      ),
    )) as TranscriptionErrorInstance;

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.kind).toBe('tier_refused');
    expect(err.status).toBe(403);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ classification: 'intimate' });
  });

  test('an unreachable admission stops the page too: it fails closed', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
        OPENAI_KEY,
      ),
    )) as TranscriptionErrorInstance;

    expect(err.kind).toBe('network');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['[no text found]', 'no_text_found'],
    ["I'm unable to transcribe this image.", 'transcription_refused'],
  ])('a reply of %j is the %s kind, never the page text', async (reply, kind) => {
    mockFetch.mockReturnValueOnce(admitted());
    mockFetch.mockReturnValueOnce(openaiReply(reply));

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
        OPENAI_KEY,
      ),
    )) as TranscriptionErrorInstance;

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.kind).toBe(kind);
  });

  test.each([
    [{ error: { code: 'insufficient_quota' } }, 429, 'credit_exhausted'],
    [{ error: { code: 'rate_limit_exceeded' } }, 429, 'rate_limited'],
    [{ error: { message: 'invalid api key' } }, 401, 'provider_error'],
  ])('a vendor refusal %j (%i) is %s', async (body, status, kind) => {
    mockFetch.mockReturnValueOnce(admitted());
    mockFetch.mockReturnValueOnce(jsonResponse(body, status));

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
        OPENAI_KEY,
      ),
    )) as TranscriptionErrorInstance;

    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  test('a stored key that names no vendor is never sent anywhere', async () => {
    mockFetch.mockReturnValueOnce(admitted());

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
        'garbage',
      ),
    )) as TranscriptionErrorInstance;

    expect(err.kind).toBe('unknown');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(ADMISSION_URL);
  });
});

describe('journal.transcribePage without a key, outside a development build', () => {
  afterEach(() => {
    mockKeylessReachesServer = true;
  });

  test('refuses key_required on the device and sends nothing anywhere', async () => {
    mockKeylessReachesServer = false;

    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    )) as TranscriptionErrorInstance;

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.kind).toBe('key_required');
    expect(err.status).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('journal.transcribePage without a key', () => {
  test('goes to the server with no key header at all', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ text: 'x' }));
    await journal.transcribePage(
      { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
      'tok',
    );

    expect(mockFetch.mock.calls[0][0]).toBe(PAGE_URL);
    expect(mockFetch.mock.calls[0][1].headers[LLM_API_KEY_HEADER]).toBeUndefined();
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

    const promise = journal.transcribePage(
      { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
      'tok',
    );
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
      name: '422 no_text_found is its own kind, not invalid_image',
      status: 422,
      body: { detail: 'no_text_found' },
      kind: 'no_text_found',
    },
    {
      name: '422 transcription_refused is its own kind, not invalid_image',
      status: 422,
      body: { detail: 'transcription_refused' },
      kind: 'transcription_refused',
    },
    {
      name: '422 pydantic array detail defaults to invalid_image',
      status: 422,
      body: { detail: [{ loc: ['body', 'image_base64'], msg: 'bad image', type: 'value_error' }] },
      kind: 'invalid_image',
    },
    {
      name: '403 tier_refused is its own kind: the declared tier may not be read (#3059)',
      status: 403,
      body: { detail: 'tier_refused' },
      kind: 'tier_refused',
    },
    {
      name: '403 with any other detail is not mistaken for a tier refusal',
      status: 403,
      body: { detail: 'forbidden' },
      kind: 'unknown',
    },
    {
      name: '402 insufficient_offerings maps to wallet_exhausted',
      status: 402,
      body: { detail: 'insufficient_offerings' },
      kind: 'wallet_exhausted',
    },
    {
      name: '402 llm_key_required asks for a key, and is NOT wallet exhaustion',
      status: 402,
      body: { detail: 'llm_key_required' },
      kind: 'key_required',
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
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
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
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('does not retry a 429 (POST is non-idempotent)', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ error: 'Rate limit exceeded: 20 per 1 minute' }, 429),
    );
    await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('maps a network failure to kind network with a null status', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const err = await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
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
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
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
      journal.transcribePage(
        { imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
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
      journal.transcribePage(
        { imageBase64: SENTINEL_PAYLOAD, mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    );
    assertNoSecretLeak(logSpy);
    assertNoSecretLeak(warnSpy);
    assertNoSecretLeak(errorSpy);
    expect((err as TranscriptionErrorInstance).message).not.toContain(SENTINEL_PAYLOAD);
  });
});

describe('journal.transcribePage exhausted-balance classification', () => {
  // The page-reading surface keeps its own closed taxonomy (TranscriptionErrorKind)
  // and its own copy map, so fixing errorMessages.ts alone leaves this door open:
  // a 402 here collapses into `wallet_exhausted` -- the monthly free-allotment
  // story, whose remedy ("add your own API key in Settings") is exactly the key
  // that just came back empty -- and a 503 falls through to `unknown`.
  test("a caller's spent key is not the monthly free allotment", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'llm_credit_exhausted' }, 402));
    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    )) as TranscriptionErrorInstance;

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.kind).not.toBe('wallet_exhausted');
    expect(err.kind).toBe('credit_exhausted');
  });

  test('no 503 is a provider-balance story any more: the server key is retired', async () => {
    // The server's own key never pays for a page (ADR 0009 phase (a), #3067), so
    // the 503 it once answered for a spent server balance is gone, and with it
    // the kind that told the writer "restoring it is ours".
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'llm_service_credit_exhausted' }, 503));
    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    )) as TranscriptionErrorInstance;

    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.kind).toBe('unknown');
  });

  test('a genuine spent wallet still classifies as wallet_exhausted', async () => {
    // The regression guard for the 402 sub-map: the app's own metering is the
    // common 402 and its copy must not be repointed at the provider story.
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'insufficient_offerings' }, 402));
    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    )) as TranscriptionErrorInstance;

    expect(err.kind).toBe('wallet_exhausted');
  });

  test('a keyless 402 is its own actionable kind, not the catch-all (#3096)', async () => {
    // A server with nothing credits could buy refuses every keyless page with
    // `llm_key_required`. That is a remedy the writer can act on -- add a key --
    // so it must not collapse into `unknown`, whose copy only says "try again".
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'llm_key_required' }, 402));
    const err = (await captureError(
      journal.transcribePage(
        { imageBase64: 'abc', mediaType: 'image/png', classification: 'personal' },
        'tok',
      ),
    )) as TranscriptionErrorInstance;

    expect(err.kind).not.toBe('unknown');
    expect(err.kind).toBe('key_required');
  });
});
