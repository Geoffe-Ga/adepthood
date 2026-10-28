/* global describe, test, expect, beforeEach, jest */
/**
 * The writer's key rides a journal save or document import only when their
 * vault said it writes with that vendor (#3437), and never after sign-out.
 */
import {
  LLM_API_KEY_HEADER,
  SAVE_KEY_DISCOVERY_WAIT_MS,
  VAULT_KEY_VENDORS_TTL_MS,
  botmasonUsage,
  corpus,
  journal,
  resetLlmApiKey,
  setLlmApiKeyGetter,
  vaultRequestKeys,
} from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const KEY = 'sk-ant-api03-onboarding3437'; // pragma: allowlist secret
const ROTATED_KEY = 'sk-ant-api03-rotated3437'; // pragma: allowlist secret
const VENDORS_PATH = '/user/vault-key-vendors';

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const USAGE = {
  resonance_route: 'vault_bound',
  monthly_messages_used: 0,
  monthly_messages_remaining: 20,
  monthly_cap: 20,
  monthly_reset_date: '2026-11-01T00:00:00Z',
  offering_balance: 0,
};

const ENTRY = {
  id: 1,
  message: 'hello',
  sender: 'user',
  user_id: 1,
  timestamp: '2026-10-16T00:00:00Z',
};

const IMPORTED = { destination: 'vault', stored: true, tags: [], message: 'Stored.' };

/** Answer each path the way the server would, with ``vendors`` as the vault's answer. */
function serve(vendors: unknown): void {
  mockFetch.mockImplementation((url: string) => {
    if (url.endsWith(VENDORS_PATH)) return jsonResponse(vendors);
    if (url.endsWith('/user/usage')) return jsonResponse(USAGE);
    if (url.endsWith('/corpus/import')) return jsonResponse(IMPORTED, 202);
    return jsonResponse(ENTRY, 201);
  });
}

function callsTo(path: string): [string, { headers: Record<string, string> }][] {
  return (mockFetch.mock.calls as [string, { headers: Record<string, string> }][]).filter(([url]) =>
    url.endsWith(path),
  );
}

function lastHeadersTo(path: string): Record<string, string> {
  const last = callsTo(path).at(-1);
  if (last === undefined) throw new Error(`no request was sent to ${path}`);
  return last[1].headers;
}

/** Let a background read the save started settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockFetch.mockReset();
  resetLlmApiKey();
  setLlmApiKeyGetter(() => KEY);
});

describe('the onboarding key header (#3437)', () => {
  test('the first document import discovers vendors before sending the saved key', async () => {
    serve({ vendors: ['anthropic'] });

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(callsTo(VENDORS_PATH)).toHaveLength(1);
    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBe(KEY);
  });

  test('an upload refreshes an empty vendor answer left from an older vault', async () => {
    serve({ vendors: [] });
    await vaultRequestKeys.get('tok');
    serve({ vendors: ['anthropic'] });

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBe(KEY);
    expect(callsTo(VENDORS_PATH)).toHaveLength(2);
  });

  test('an upload withholds its key when the vault no longer accepts that vendor', async () => {
    serve({ vendors: ['anthropic'] });
    await vaultRequestKeys.get('tok');
    serve({ vendors: [] });

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBeUndefined();
    expect(callsTo(VENDORS_PATH)).toHaveLength(2);
  });

  test.each([
    ['a different vendor', { vendors: ['openai'] }],
    ['no eligible vendor', { vendors: [] }],
  ])('a first import withholds the key for %s', async (_name, vendors) => {
    serve(vendors);

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(callsTo(VENDORS_PATH)).toHaveLength(1);
    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test.each([null, 'not-a-provider-key'])('an import with key %s skips discovery', async (key) => {
    setLlmApiKeyGetter(() => key);
    serve({ vendors: ['anthropic'] });

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(callsTo(VENDORS_PATH)).toHaveLength(0);
    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test.each([false, true])('failed discovery with cache=%s withholds the key', async (cached) => {
    if (cached) {
      serve({ vendors: ['anthropic'] });
      await vaultRequestKeys.get('tok');
    }
    mockFetch.mockImplementation((url: string) =>
      url.endsWith(VENDORS_PATH)
        ? jsonResponse({ detail: 'refused' }, 403)
        : jsonResponse(IMPORTED, 202),
    );

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(callsTo(VENDORS_PATH)).toHaveLength(cached ? 2 : 1);
    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test.each([null, ROTATED_KEY])('discovery honors a key changed to %s', async (key) => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith(VENDORS_PATH)) {
        setLlmApiKeyGetter(() => key);
        return jsonResponse({ vendors: ['anthropic'] });
      }
      return jsonResponse(IMPORTED, 202);
    });

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBe(key ?? undefined);
  });

  test('an import waiting for vendor discovery stops when the session ends', async () => {
    let release: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve({ vendors: ['anthropic'] });
    const respond = mockFetch.getMockImplementation();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(VENDORS_PATH)) await discovery;
      return respond?.(url);
    });

    const uploading = corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'old-account',
    );
    const result = uploading.then(
      () => 'sent',
      () => 'cancelled',
    );
    resetLlmApiKey();
    setLlmApiKeyGetter(() => 'sk-ant-api03-another-account');
    release?.();

    expect(await result).toBe('cancelled');
    expect(callsTo('/corpus/import')).toHaveLength(0);
    await settle();
    const readsAfterCancellation = callsTo(VENDORS_PATH).length;
    serve({ vendors: [] });

    await journal.create({ message: 'another account' }, { token: 'new-account' });

    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
    expect(readsAfterCancellation).toBe(1);
  });

  test('a save carries the key once the vault said it writes with that vendor', async () => {
    serve({ vendors: ['anthropic'] });
    await vaultRequestKeys.get('tok');

    await journal.create({ message: 'hello' }, { token: 'tok', idempotencyKey: 'idem-1' });

    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBe(KEY);
    expect(lastHeadersTo('/journal/')['Idempotency-Key']).toBe('idem-1');
  });

  test.each([
    ['another vendor', { vendors: ['openai'] }],
    ['no vendor', { vendors: [] }],
    ['a malformed answer', { vendors: 'anthropic' }],
  ])('a save carries no key when the vault names %s', async (_name, answer) => {
    serve(answer);
    await vaultRequestKeys.get('tok');

    await journal.create({ message: 'hello' }, { token: 'tok' });

    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('the first save waits briefly for discovery and carries the key it confirms', async () => {
    serve({ vendors: ['anthropic'] });

    await journal.create({ message: 'hello' }, { token: 'tok' });
    await journal.create({ message: 'again' }, { token: 'tok' });

    expect(callsTo('/journal/').map(([, init]) => init.headers[LLM_API_KEY_HEADER])).toEqual([
      KEY,
      KEY,
    ]);
    expect(callsTo(VENDORS_PATH)).toHaveLength(1);
  });

  test('concurrent first saves share one discovery read', async () => {
    serve({ vendors: ['anthropic'] });

    await Promise.all([
      journal.create({ message: 'one' }, { token: 'tok' }),
      journal.update(1, { message: 'two' }, 'tok'),
    ]);

    expect(callsTo(VENDORS_PATH)).toHaveLength(1);
  });

  test('a save does not wait past the discovery bound: it goes keyless and the read fills the cache', async () => {
    jest.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const discovery = new Promise<void>((resolve) => {
        release = resolve;
      });
      serve({ vendors: ['anthropic'] });
      const respond = mockFetch.getMockImplementation();
      mockFetch.mockImplementation(async (url: string) => {
        if (url.endsWith(VENDORS_PATH)) await discovery;
        return respond?.(url);
      });

      const saving = journal.create({ message: 'hello' }, { token: 'tok' });
      await jest.advanceTimersByTimeAsync(SAVE_KEY_DISCOVERY_WAIT_MS);
      await saving;
      expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();

      release?.();
      await jest.advanceTimersByTimeAsync(0);
      await journal.create({ message: 'again' }, { token: 'tok' });
      expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBe(KEY);
      expect(callsTo(VENDORS_PATH)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a save re-asks once an empty answer is stale, so a Vault upgrade reaches saves', async () => {
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      serve({ vendors: [] });
      await vaultRequestKeys.get('tok');
      serve({ vendors: ['anthropic'] });

      await journal.create({ message: 'fresh empty answer' }, { token: 'tok' });
      expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
      expect(callsTo(VENDORS_PATH)).toHaveLength(1);

      now.mockReturnValue(start + VAULT_KEY_VENDORS_TTL_MS);
      await journal.create({ message: 'after the upgrade' }, { token: 'tok' });

      expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBe(KEY);
      expect(callsTo(VENDORS_PATH)).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });

  test('a stale answer whose refresh fails is not reused: the save goes keyless', async () => {
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      serve({ vendors: ['anthropic'] });
      await vaultRequestKeys.get('tok');
      now.mockReturnValue(start + VAULT_KEY_VENDORS_TTL_MS);
      mockFetch.mockImplementation((url: string) =>
        url.endsWith(VENDORS_PATH)
          ? jsonResponse({ detail: 'refused' }, 403)
          : jsonResponse(ENTRY, 201),
      );

      await journal.create({ message: 'hello' }, { token: 'tok' });

      expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  test('a save waiting for discovery is refused, not sent, when the session ends meanwhile', async () => {
    let release: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve({ vendors: ['anthropic'] });
    const respond = mockFetch.getMockImplementation();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith(VENDORS_PATH)) await discovery;
      return respond?.(url);
    });

    const saving = journal.update(1, { message: 'written by the first account' }, 'old-account');
    const outcome = saving.then(
      () => 'sent',
      (err: unknown) => err,
    );
    resetLlmApiKey();
    release?.();

    expect(await outcome).toMatchObject({ status: 0, detail: 'session_changed' });
    expect(callsTo('/journal/1')).toHaveLength(0);
  });

  test('an edit that changes the body carries the key under the same rule', async () => {
    serve({ vendors: ['anthropic'] });

    await journal.update(1, { message: 'edited' }, 'tok');

    expect(lastHeadersTo('/journal/1')[LLM_API_KEY_HEADER]).toBe(KEY);
  });

  test.each([
    ['a title-only edit', { title: 'Willow' }],
    ['a status-only edit', { status: 'finished' as const }],
  ])('%s re-ingests nothing, so it carries no key and asks nothing', async (_name, patch) => {
    serve({ vendors: ['anthropic'] });

    await journal.update(1, patch, 'tok');

    expect(callsTo(VENDORS_PATH)).toHaveLength(0);
    expect(lastHeadersTo('/journal/1')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('a save without a key never asks the vault', async () => {
    setLlmApiKeyGetter(() => null);
    serve({ vendors: ['anthropic'] });

    await journal.create({ message: 'hello' }, { token: 'tok' });
    await settle();

    expect(callsTo(VENDORS_PATH)).toHaveLength(0);
    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('the usage snapshot never asks the vault and never arms the key', async () => {
    serve({ vendors: ['anthropic'] });
    await botmasonUsage.get('tok');
    expect(callsTo(VENDORS_PATH)).toHaveLength(0);

    serve({ vendors: [] });
    await journal.create({ message: 'hello' }, { token: 'tok' });

    expect(callsTo(VENDORS_PATH)).toHaveLength(1);
    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('sign-out forgets the vault’s answer, so the next account’s save asks its own vault', async () => {
    serve({ vendors: ['anthropic'] });
    await vaultRequestKeys.get('tok');
    resetLlmApiKey();
    setLlmApiKeyGetter(() => KEY);
    serve({ vendors: [] });

    await journal.create({ message: 'hello' }, { token: 'tok' });

    expect(callsTo(VENDORS_PATH)).toHaveLength(2);
    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('an answer in flight across sign-out never arms the next account', async () => {
    serve({ vendors: ['anthropic'] });
    const inFlight = vaultRequestKeys.get('old-account');
    resetLlmApiKey();
    setLlmApiKeyGetter(() => KEY);
    await inFlight;
    serve({ vendors: [] });

    await journal.create({ message: 'hello' }, { token: 'new-account' });

    expect(lastHeadersTo('/journal/')[LLM_API_KEY_HEADER]).toBeUndefined();
  });

  test('a document import carries the key under the same rule', async () => {
    serve({ vendors: ['anthropic'] });
    await vaultRequestKeys.get('tok');

    await corpus.importDocument(
      { filename: 'a.md', contentBase64: 'aGVsbG8=', classification: 'personal' },
      'tok',
    );

    expect(lastHeadersTo('/corpus/import')[LLM_API_KEY_HEADER]).toBe(KEY);
  });
});
