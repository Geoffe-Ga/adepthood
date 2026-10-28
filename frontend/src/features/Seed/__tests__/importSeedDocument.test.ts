/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import * as FileSystem from 'expo-file-system';

import { attemptSeedDocument, importSeedDocument } from '../importSeedDocument';
import type { PickedDocument } from '../pickSeedDocuments';
import { MAX_SEED_DOCUMENT_BYTES } from '../readSeedDocument';

import { corpus } from '@/api';
import { setNetworkOnlineGetter } from '@/api/networkSignal';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

const mocked = FileSystem as unknown as {
  __fileBase64: jest.Mock;
  __fileSize: jest.Mock;
};

/** Distinctive fixture so a leak into a log or a payload is unmistakable. */
const SENTINEL_BASE64 = 'WlpaWl9TRU5USU5FTF9ET0NVTUVOVF9aWlpa';

function document(overrides: Partial<PickedDocument> = {}): PickedDocument {
  return { name: 'seed.md', uri: 'file:///cache/seed.md', size: 64, seedable: true, ...overrides };
}

function accepted(status = 202, body: unknown = undefined) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

/** What the endpoint answers an account that has connected no vault. */
function corpusReply(corpusStatus: string, fragmentId: number | null = null) {
  return accepted(202, {
    destination: 'corpus',
    stored: corpusStatus === 'stored',
    vault_status: null,
    vault_ref: null,
    tags: [],
    corpus_status: corpusStatus,
    fragment_id: fragmentId,
    message: 'something honest',
  });
}

/** What it answers an account that has one. */
function vaultReply(vaultStatus: string) {
  return accepted(202, {
    destination: 'vault',
    stored: vaultStatus === 'accepted',
    vault_status: vaultStatus,
    vault_ref: null,
    tags: [],
    corpus_status: null,
    fragment_id: null,
    message: 'something honest',
  });
}

afterEach(() => {
  setNetworkOnlineGetter(null);
});

beforeEach(() => {
  mockFetch.mockReset();
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue(SENTINEL_BASE64);
  mocked.__fileSize.mockReturnValue(64);
});

describe('picker to request body', () => {
  test('names where a folder document sat, so same-named notes stay two documents', async () => {
    mockFetch.mockReturnValueOnce(vaultReply('accepted'));

    await importSeedDocument(
      document({
        name: 'Index.md',
        source: { namespace: 'My Vault', relativePath: 'Work/Index.md' },
      }),
      'personal',
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.filename).toBe('Index.md');
    expect(body.source_namespace).toBe('My Vault');
    expect(body.source_relative_path).toBe('Work/Index.md');
  });

  test('sends the picked file as base64 JSON under its own name and tier', async () => {
    mockFetch.mockReturnValueOnce(corpusReply('stored', 7));

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('in_corpus');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/import');
    expect(JSON.parse(init.body)).toEqual({
      filename: 'seed.md',
      content_base64: SENTINEL_BASE64,
      classification: 'personal',
    });
  });

  test('carries the intimate tier through unchanged', async () => {
    mockFetch.mockReturnValueOnce(corpusReply('tier_refused'));

    await importSeedDocument(document(), 'intimate');

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });
});

describe('an account with no vault', () => {
  test('is told it needs a place for its corpus, in one request', async () => {
    // #3015/#3016: a corpus lives in a vault, so with none the server keeps
    // nothing and says so. The run renders that answer as its own status, not
    // as a failure and not as a document that landed.
    mockFetch.mockReturnValueOnce(corpusReply('vault_required'));

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('vault_required');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://test/corpus/import');
  });

  test.each([
    ['stored', 'in_corpus'],
    ['consent_required', 'consent_required'],
    ['tier_refused', 'tier_refused'],
    ['format_unreadable', 'format_unreadable'],
    ['not_text', 'not_text'],
    ['empty_document', 'empty_document'],
    ['document_too_long', 'document_too_long'],
    ['unclassified', 'unclassified'],
    ['vault_required', 'vault_required'],
  ])('renders the corpus %s answer as %s', async (wire, expected) => {
    mockFetch.mockReturnValueOnce(corpusReply(wire as string));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe(expected);
  });

  test('reaches the import route once and no other surface', async () => {
    mockFetch.mockReturnValue(corpusReply('consent_required'));

    await importSeedDocument(document(), 'personal');

    // Asserted as "exactly this one call" rather than as "not the old vault
    // route": that route has since been retired, so naming it would be a guard
    // against a URL nothing could reach either way.
    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual(['http://test/corpus/import']);
  });
});

describe('an account that has a vault', () => {
  test.each([
    ['accepted', 'ingested'],
    ['vault_unavailable', 'vault_unavailable'],
    ['capability_unsupported', 'capability_unsupported'],
    ['degraded', 'degraded'],
  ])('renders the vault %s answer as %s', async (wire, expected) => {
    mockFetch.mockReturnValueOnce(vaultReply(wire as string));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe(expected);
  });

  test('reaches the same route as an account without one', async () => {
    // The routing rule is the server's, so the request is identical either way.
    mockFetch.mockReturnValueOnce(vaultReply('accepted'));

    await importSeedDocument(document(), 'personal');

    expect(mockFetch.mock.calls[0][0]).toBe('http://test/corpus/import');
  });
});

describe('what never reaches the network', () => {
  test('an oversize document is refused on device', async () => {
    const status = await importSeedDocument(
      document({ size: MAX_SEED_DOCUMENT_BYTES + 1 }),
      'personal',
    );

    expect(status).toBe('too_large');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a format nothing can read is refused on device', async () => {
    const status = await importSeedDocument(
      document({ name: 'installer.exe', seedable: false }),
      'personal',
    );

    expect(status).toBe('unsupported_format');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a device known to be offline never sends, and says so', async () => {
    // #3239. Only the platform's own connectivity signal may say "offline";
    // with it, the request is never made, so "wasn't sent" is a fact.
    setNetworkOnlineGetter(() => false);

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('offline');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a device with no connectivity signal still sends', async () => {
    // "We don't know" is not "offline": with no signal registered the request
    // goes, rather than being refused on a guess.
    mockFetch.mockReturnValueOnce(vaultReply('accepted'));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('ingested');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a file that will not open is refused on device', async () => {
    mocked.__fileBase64.mockRejectedValue(new Error('gone'));

    const status = await importSeedDocument(document(), 'personal');

    expect(status).toBe('unreadable');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('a request that produced no outcome', () => {
  // #3239. A request that left the device and then lost its answer may already
  // be stored: these settle as `unconfirmed`, never as a failure that claims
  // nothing was kept.
  test('a server error settles as unconfirmed rather than throwing at the run', async () => {
    mockFetch.mockReturnValue(accepted(500, { detail: 'boom' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('a timeout settles as unconfirmed', async () => {
    // The client's own clock aborting the fetch, which it reports as a timeout.
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('a dropped connection settles as unconfirmed', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('a 2xx the client cannot read settles as unconfirmed', async () => {
    mockFetch.mockReturnValue(accepted(202, { destination: 'somewhere-new' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('keeps the managed size refusal actionable rather than retryable', async () => {
    mockFetch.mockReturnValue(accepted(413, { detail: 'managed_document_too_large' }));
    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('managed_too_large');
  });

  test('keeps the size verdict when the server is the one who caught it', async () => {
    mockFetch.mockReturnValue(accepted(413, { detail: 'document_too_large' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('too_large');
  });

  test.each([
    [422, 'invalid_document'],
    [401, 'not_authenticated'],
  ])('a definite %s refusal settles as failed', async (status, detail) => {
    // The upload is a single, unretried POST, so a 4xx is the answer to the only
    // attempt there was: the server turned it away and kept nothing.
    mockFetch.mockReturnValue(accepted(status as number, { detail }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('failed');
  });

  test('a rate-limit refusal settles as rate_limited, never as a failure of the document', async () => {
    // #3556: a 429 is the server asking for a pause, not turning the document
    // away. Nothing was kept, and the same document can go again in a moment.
    mockFetch.mockReturnValue(accepted(429, { detail: 'rate_limit_exceeded' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('rate_limited');
  });

  test('a request timeout answer is not treated as a definite refusal', async () => {
    mockFetch.mockReturnValue(accepted(408, { detail: 'request_timeout' }));

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('settles as unconfirmed when the answer names a destination but no outcome', async () => {
    // A 202 means the server took the request; a body that cannot say what
    // happened to it cannot honestly be rendered as "nothing was stored".
    mockFetch.mockReturnValue(
      accepted(202, {
        destination: 'corpus',
        stored: false,
        corpus_status: null,
        tags: [],
        message: 'something honest',
      }),
    );

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('settles as unconfirmed when a vault answer carries no vault status', async () => {
    mockFetch.mockReturnValue(
      accepted(202, {
        destination: 'vault',
        stored: false,
        vault_status: null,
        tags: [],
        message: 'something honest',
      }),
    );

    await expect(importSeedDocument(document(), 'personal')).resolves.toBe('unconfirmed');
  });

  test('never writes the document bytes anywhere but the request body', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockFetch.mockReturnValueOnce(corpusReply('stored', 3));

    await importSeedDocument(document(), 'personal');

    const emitted = [warn, error, log].flatMap((spy) => spy.mock.calls.flat());
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL_BASE64);
    expect(corpus.importDocument).toBeDefined();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});

describe('one attempt, as the run sees it', () => {
  function rateLimited(retryAfter: string | null) {
    return Promise.resolve({
      ok: false,
      status: 429,
      headers: new Headers(retryAfter === null ? {} : { 'Retry-After': retryAfter }),
      json: () => Promise.resolve({ detail: 'rate_limit_exceeded' }),
    });
  }

  test("hands the run a 429's wait, so it can wait out exactly that long", async () => {
    mockFetch.mockReturnValue(rateLimited('12'));

    await expect(attemptSeedDocument(document(), 'personal')).resolves.toEqual({
      status: 'rate_limited',
      answered: false,
      retryAfterSeconds: 12,
    });
  });

  test('names no wait when the 429 named none', async () => {
    mockFetch.mockReturnValue(rateLimited(null));

    const attempt = await attemptSeedDocument(document(), 'personal');

    expect(attempt.retryAfterSeconds).toBeNull();
  });

  test('counts an answered upload toward the pace, whatever the answer said', async () => {
    mockFetch.mockReturnValueOnce(vaultReply('accepted'));
    mockFetch.mockReturnValueOnce(accepted(422, { detail: 'invalid_document' }));

    await expect(attemptSeedDocument(document(), 'personal')).resolves.toEqual({
      status: 'ingested',
      answered: true,
      retryAfterSeconds: null,
    });
    await expect(attemptSeedDocument(document(), 'personal')).resolves.toMatchObject({
      status: 'failed',
      answered: true,
    });
  });

  test('counts a request whose answer was lost, since the server may have counted it', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));

    await expect(attemptSeedDocument(document(), 'personal')).resolves.toMatchObject({
      status: 'unconfirmed',
      answered: true,
    });
  });

  test('counts nothing for a document refused on device', async () => {
    await expect(
      attemptSeedDocument(document({ name: 'x.exe', seedable: false }), 'personal'),
    ).resolves.toEqual({ status: 'unsupported_format', answered: false, retryAfterSeconds: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
