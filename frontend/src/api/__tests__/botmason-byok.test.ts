/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import { botmason, setLlmApiKeyGetter, LLM_API_KEY_HEADER } from '../index';

// Mock global fetch
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 201) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  // Clear any getter registered by a test so state does not bleed across cases.
  setLlmApiKeyGetter(null);
});

function chatPayload() {
  return {
    response: 'hi back',
    remaining_balance: 1,
    bot_entry_id: 42,
  };
}

describe('botmason.chat BYOK header', () => {
  test('omits X-LLM-API-Key header when no getter is registered', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(chatPayload()));

    await botmason.chat({ message: 'hi' }, 'jwt');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).not.toHaveProperty(LLM_API_KEY_HEADER);
  });

  test('omits header when the getter returns null', async () => {
    setLlmApiKeyGetter(() => null);
    mockFetch.mockReturnValueOnce(jsonResponse(chatPayload()));

    await botmason.chat({ message: 'hi' }, 'jwt');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).not.toHaveProperty(LLM_API_KEY_HEADER);
  });

  test('omits header when the getter returns an empty string', async () => {
    setLlmApiKeyGetter(() => '');
    mockFetch.mockReturnValueOnce(jsonResponse(chatPayload()));

    await botmason.chat({ message: 'hi' }, 'jwt');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).not.toHaveProperty(LLM_API_KEY_HEADER);
  });

  test('attaches header with the getter-supplied key', async () => {
    setLlmApiKeyGetter(() => 'sk-user-supplied');
    mockFetch.mockReturnValueOnce(jsonResponse(chatPayload()));

    await botmason.chat({ message: 'hi' }, 'jwt');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers[LLM_API_KEY_HEADER]).toBe('sk-user-supplied');
  });

  test('re-polls the getter on each call so rotations take effect immediately', async () => {
    let key: string | null = 'sk-first';
    setLlmApiKeyGetter(() => key);

    mockFetch.mockReturnValueOnce(jsonResponse(chatPayload()));
    await botmason.chat({ message: 'hi' }, 'jwt');
    expect(mockFetch.mock.calls[0][1].headers[LLM_API_KEY_HEADER]).toBe('sk-first');

    key = 'sk-second';
    mockFetch.mockReturnValueOnce(jsonResponse(chatPayload()));
    await botmason.chat({ message: 'hi again' }, 'jwt');
    expect(mockFetch.mock.calls[1][1].headers[LLM_API_KEY_HEADER]).toBe('sk-second');
  });
});
