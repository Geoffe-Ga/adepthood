/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import * as fs from 'fs';
import * as path from 'path';

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BROWSER_ACCESS_HEADER,
  DIRECT_VENDOR_ENDPOINTS,
  DirectVendorError,
  readImageDirect,
} from '../byokDirect';
import {
  DIRECT_VISION_MODELS,
  TRANSCRIPTION_MAX_TOKENS,
  TRANSCRIPTION_SYSTEM_PROMPT,
} from '../transcriptionContract';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

const OPENAI_KEY = 'sk-direct-openai-0123456789abcdef'; // pragma: allowlist secret
const ANTHROPIC_KEY = 'sk-ant-direct-anthropic-0123456789abcdef'; // pragma: allowlist secret
const IMAGE = 'IMAGE_CANARY_BASE64_7d1e';
const PAGE = { imageBase64: IMAGE, mediaType: 'image/png' } as const;
const TIMEOUT_MS = 60_000;

function vendorResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const ANTHROPIC_OK = { content: [{ type: 'text', text: 'Dear diary, the river.' }] };
const OPENAI_OK = { choices: [{ message: { content: 'Dear diary, the river.' } }] };

async function failure(key: string): Promise<DirectVendorError> {
  const err = await readImageDirect(key, PAGE, { timeoutMs: TIMEOUT_MS }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DirectVendorError);
  return err as DirectVendorError;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('readImageDirect: Anthropic, straight from the device', () => {
  test('posts the page to the Messages API with the key and browser-access headers', async () => {
    mockFetch.mockReturnValueOnce(vendorResponse(ANTHROPIC_OK));

    const text = await readImageDirect(ANTHROPIC_KEY, PAGE, { timeoutMs: TIMEOUT_MS });

    expect(text).toBe('Dear diary, the river.');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(init.headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(init.headers[ANTHROPIC_BROWSER_ACCESS_HEADER]).toBe('true');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      model: DIRECT_VISION_MODELS.anthropic,
      max_tokens: TRANSCRIPTION_MAX_TOKENS,
      system: TRANSCRIPTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } },
          ],
        },
      ],
    });
  });

  test('reads the first text block, skipping any other block kind', async () => {
    mockFetch.mockReturnValueOnce(
      vendorResponse({ content: [{ type: 'thinking' }, { type: 'text', text: 'page' }] }),
    );
    await expect(readImageDirect(ANTHROPIC_KEY, PAGE, { timeoutMs: TIMEOUT_MS })).resolves.toBe(
      'page',
    );
  });
});

describe('readImageDirect: OpenAI, straight from the device', () => {
  test('posts the page to Chat Completions with a bearer key and a data-URL image', async () => {
    mockFetch.mockReturnValueOnce(vendorResponse(OPENAI_OK));

    const text = await readImageDirect(OPENAI_KEY, PAGE, { timeoutMs: TIMEOUT_MS });

    expect(text).toBe('Dear diary, the river.');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(init.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      model: DIRECT_VISION_MODELS.openai,
      max_tokens: TRANSCRIPTION_MAX_TOKENS,
      messages: [
        { role: 'system', content: TRANSCRIPTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}` } }],
        },
      ],
    });
  });
});

describe('readImageDirect: a vendor refusal keeps the server-side taxonomy', () => {
  test.each([
    ['openai spent quota', OPENAI_KEY, 429, { error: { code: 'insufficient_quota' } }],
    ['openai hard cap', OPENAI_KEY, 429, { error: { code: 'billing_hard_limit_reached' } }],
    [
      'anthropic low balance',
      ANTHROPIC_KEY,
      400,
      { error: { message: 'Your credit balance is too low to access the Anthropic API.' } },
    ],
  ])('%s is credit_exhausted', async (_name, key, status, body) => {
    mockFetch.mockReturnValueOnce(vendorResponse(body, status));
    expect((await failure(key)).kind).toBe('credit_exhausted');
  });

  test.each([
    ['openai rate limit', OPENAI_KEY, { error: { code: 'rate_limit_exceeded' } }],
    // A 429 is never a spent balance on Anthropic, whatever its prose says.
    [
      'anthropic 429 with credit prose',
      ANTHROPIC_KEY,
      { error: { message: 'credit balance is too low' } },
    ],
  ])('%s is rate_limited', async (_name, key, body) => {
    mockFetch.mockReturnValueOnce(vendorResponse(body, 429));
    expect((await failure(key)).kind).toBe('rate_limited');
  });

  test.each([
    ['a bad key', ANTHROPIC_KEY, 401, { error: { message: 'invalid x-api-key' } }],
    ['another 400', ANTHROPIC_KEY, 400, { error: { message: 'messages: field required' } }],
    ['an outage', OPENAI_KEY, 503, {}],
    ['an unreadable body', OPENAI_KEY, 500, null],
  ])('%s is provider_error', async (_name, key, status, body) => {
    mockFetch.mockReturnValueOnce(vendorResponse(body, status));
    expect((await failure(key)).kind).toBe('provider_error');
  });

  test.each([
    ['anthropic', ANTHROPIC_KEY, { content: [] }],
    ['openai', OPENAI_KEY, { choices: [] }],
  ])('a %s success with no text is provider_error', async (_name, key, body) => {
    mockFetch.mockReturnValueOnce(vendorResponse(body));
    expect((await failure(key)).kind).toBe('provider_error');
  });

  test('a key that names no vendor never leaves the device', async () => {
    expect((await failure('not-a-provider-key')).kind).toBe('unrecognised_key');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a dropped connection is network', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect((await failure(OPENAI_KEY)).kind).toBe('network');
  });
});

describe('readImageDirect: timeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a stalled vendor call is aborted and reported as timeout', async () => {
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

    const pending = readImageDirect(OPENAI_KEY, PAGE, { timeoutMs: TIMEOUT_MS }).catch(
      (e: unknown) => e,
    );
    jest.advanceTimersByTime(TIMEOUT_MS);
    const err = (await pending) as DirectVendorError;

    expect(err).toBeInstanceOf(DirectVendorError);
    expect(err.kind).toBe('timeout');
  });
});

describe('readImageDirect: privacy', () => {
  test('no failure carries the key, the page, or the vendor body', async () => {
    const secretBody = { error: { message: `echo ${ANTHROPIC_KEY} ${IMAGE}` } };
    mockFetch.mockReturnValueOnce(vendorResponse(secretBody, 400));

    const err = await failure(ANTHROPIC_KEY);

    const surfaced = `${err.message} ${String(err.stack)} ${JSON.stringify(err)}`;
    expect(surfaced).not.toContain(ANTHROPIC_KEY);
    expect(surfaced).not.toContain(IMAGE);
    expect(err.cause).toBeUndefined();
  });
});

describe('the enforced CSP admits each direct vendor endpoint', () => {
  test('every endpoint origin is in connect-src on every header nginx.conf sets', () => {
    const conf = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'nginx.conf'), 'utf-8');
    const policies = [...conf.matchAll(/add_header Content-Security-Policy "([^"]*)"/g)].map(
      ([, policy = '']) => /connect-src ([^;]+)/.exec(policy)?.[1]?.split(/\s+/) ?? [],
    );

    expect(policies.length).toBeGreaterThan(0);
    for (const endpoint of Object.values(DIRECT_VENDOR_ENDPOINTS)) {
      const { origin } = new URL(endpoint);
      for (const sources of policies) expect(sources).toContain(origin);
    }
  });
});
