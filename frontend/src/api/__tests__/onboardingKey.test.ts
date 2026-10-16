/* global describe, test, expect, beforeEach, jest */
/**
 * The writer's key rides a journal save or document import only when their
 * vault said it writes with that vendor (#3437), and never after sign-out.
 */
import {
  LLM_API_KEY_HEADER,
  botmasonUsage,
  corpus,
  journal,
  resetLlmApiKey,
  setLlmApiKeyGetter,
} from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const KEY = 'sk-ant-api03-onboarding3437'; // pragma: allowlist secret

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function usage(vendors: string[] | undefined) {
  return {
    resonance_route: 'vault_bound',
    monthly_messages_used: 0,
    monthly_messages_remaining: 20,
    monthly_cap: 20,
    monthly_reset_date: '2026-11-01T00:00:00Z',
    offering_balance: 0,
    ...(vendors === undefined ? {} : { vault_key_vendors: vendors }),
  };
}

const ENTRY = {
  id: 1,
  message: 'hello',
  sender: 'user',
  user_id: 1,
  timestamp: '2026-10-16T00:00:00Z',
};

function lastHeaders(): Record<string, string> {
  const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [
    string,
    { headers: Record<string, string> },
  ];
  return init.headers;
}

beforeEach(() => {
  mockFetch.mockReset();
  resetLlmApiKey();
  setLlmApiKeyGetter(() => KEY);
});

describe('the onboarding key header (#3437)', () => {
  test('a save carries the key once the vault said it writes with that vendor', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(usage(['anthropic'])));
    await botmasonUsage.get('tok');
    mockFetch.mockReturnValueOnce(jsonResponse(ENTRY, 201));

    await journal.create({ message: 'hello' }, { token: 'tok', idempotencyKey: 'idem-1' });

    expect(lastHeaders()[LLM_API_KEY_HEADER]).toBe(KEY);
    expect(lastHeaders()['Idempotency-Key']).toBe('idem-1');
  });

  test.each([
    ['another vendor', ['openai']],
    ['no vendor', []],
    ['an older server', undefined],
  ])('a save carries no key when the vault names %s', async (_name, vendors) => {
    mockFetch.mockReturnValueOnce(jsonResponse(usage(vendors)));
    await botmasonUsage.get('tok');
    mockFetch.mockReturnValueOnce(jsonResponse(ENTRY, 201));

    await journal.create({ message: 'hello' }, { token: 'tok' });

    expect(lastHeaders()[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('sign-out forgets the vault’s answer, so the next account’s save carries nothing', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(usage(['anthropic'])));
    await botmasonUsage.get('tok');
    resetLlmApiKey();
    setLlmApiKeyGetter(() => KEY);
    mockFetch.mockReturnValueOnce(jsonResponse(ENTRY, 201));

    await journal.create({ message: 'hello' }, { token: 'tok' });

    expect(lastHeaders()[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('a document import carries the key under the same rule', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(usage(['anthropic'])));
    await botmasonUsage.get('tok');
    mockFetch.mockReturnValueOnce(
      jsonResponse({ destination: 'vault', stored: true, tags: [], message: 'Stored.' }, 202),
    );

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(lastHeaders()[LLM_API_KEY_HEADER]).toBe(KEY);
  });
});
