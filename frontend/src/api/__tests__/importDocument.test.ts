/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { corpus, DocumentUploadError, UPLOAD_DOCUMENT_TIMEOUT_MS } from '../index';
import { documentImportSchema } from '../schemas';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

/** Distinctive fixture so a leak into a log or an error message is unmistakable. */
const SENTINEL_BASE64 = 'WlpaWl9TRU5USU5FTF9ET0NVTUVOVF9aWlpa';

const VAULT_BODY = {
  destination: 'vault',
  stored: true,
  vault_status: 'accepted',
  vault_ref: 'frag-42',
  tags: ['reflection'],
  corpus_status: null,
  fragment_id: null,
  message: 'Your document is in your vault.',
};

const CORPUS_BODY = {
  destination: 'corpus',
  stored: true,
  vault_status: null,
  vault_ref: null,
  tags: [],
  corpus_status: 'stored',
  fragment_id: 7,
  message: 'Your document is in your corpus.',
};

function jsonResponse(data: unknown, status = 202) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function importSeed(classification: 'personal' | 'intimate' = 'personal') {
  return corpus.importDocument(
    { filename: 'seed.md', contentBase64: SENTINEL_BASE64, classification },
    'tok',
  );
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('corpus.importDocument request shape', () => {
  test('POSTs /corpus/import with a snake_case JSON body and bearer auth', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CORPUS_BODY));

    await importSeed();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/corpus/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      filename: 'seed.md',
      content_base64: SENTINEL_BASE64,
      classification: 'personal',
    });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  test('sends JSON, never a multipart surface', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CORPUS_BODY));

    await importSeed();

    const [, init] = mockFetch.mock.calls[0];
    expect(typeof init.body).toBe('string');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  test('forwards the chosen classification unchanged, intimate included', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CORPUS_BODY));

    await importSeed('intimate');

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });

  test('names where a folder document sat, as one pair, when it came from a folder', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(VAULT_BODY));

    await corpus.importDocument(
      {
        filename: 'Index.md',
        contentBase64: SENTINEL_BASE64,
        classification: 'personal',
        source: { namespace: 'My Vault', relativePath: 'Work/Index.md' },
      },
      'tok',
    );

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      filename: 'Index.md',
      content_base64: SENTINEL_BASE64,
      classification: 'personal',
      source_namespace: 'My Vault',
      source_relative_path: 'Work/Index.md',
    });
  });

  test('sends no folder fields for a document chosen on its own', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CORPUS_BODY));

    await importSeed();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('source_namespace');
    expect(body).not.toHaveProperty('source_relative_path');
  });

  test('asks one route for one destination, never a second', async () => {
    // The routing rule is the server's. The client makes no vault lookup of its
    // own and never retries a "corpus" answer against the vault surface.
    mockFetch.mockReturnValueOnce(jsonResponse(CORPUS_BODY));

    await importSeed();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('corpus.importDocument response', () => {
  test('resolves with the corpus outcome on a 202', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CORPUS_BODY));

    await expect(importSeed()).resolves.toEqual(CORPUS_BODY);
  });

  test('resolves with the vault outcome for an account that has one', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(VAULT_BODY));

    await expect(importSeed()).resolves.toEqual(VAULT_BODY);
  });

  test.each(['accepted', 'vault_unavailable', 'capability_unsupported', 'degraded'])(
    'validates the %s vault outcome',
    (vaultStatus) => {
      const parsed = documentImportSchema.parse({
        destination: 'vault',
        stored: vaultStatus === 'accepted',
        vault_status: vaultStatus,
        vault_ref: null,
        tags: [],
        message: 'something honest',
      });

      expect(parsed.vault_status).toBe(vaultStatus);
    },
  );

  test.each([
    'stored',
    'consent_required',
    'tier_refused',
    'format_unreadable',
    'not_text',
    'empty_document',
    'document_too_long',
    'unclassified',
    'vault_required',
  ])('validates the %s corpus outcome', (corpusStatus) => {
    const parsed = documentImportSchema.parse({
      destination: 'corpus',
      stored: corpusStatus === 'stored',
      corpus_status: corpusStatus,
      tags: [],
      message: 'something honest',
    });

    expect(parsed.corpus_status).toBe(corpusStatus);
  });

  test('parses the answer an account with no vault gets, rather than rejecting it', () => {
    // #3016: a corpus lives in a vault, so an account without one is answered
    // vault_required and nothing is stored. A client whose enum lacked the
    // value would render every such import as a failure it is not.
    const body = {
      destination: 'corpus',
      stored: false,
      vault_status: null,
      vault_ref: null,
      tags: [],
      corpus_status: 'vault_required',
      fragment_id: null,
      message: 'Nothing was stored.',
    };

    expect(documentImportSchema.parse(body)).toEqual(body);
  });

  test('rejects a destination the client has no rendering for', () => {
    expect(() =>
      documentImportSchema.parse({
        destination: 'somewhere_else',
        stored: false,
        tags: [],
        message: 'hm',
      }),
    ).toThrow();
  });

  test('rejects a corpus status the client has no rendering for', () => {
    expect(() =>
      documentImportSchema.parse({
        destination: 'corpus',
        stored: false,
        corpus_status: 'quarantined',
        tags: [],
        message: 'hm',
      }),
    ).toThrow();
  });
});

describe('corpus.importDocument failures', () => {
  async function importAndCatch(): Promise<unknown> {
    return importSeed().catch((e: unknown) => e);
  }

  test.each([
    [413, 'too_large'],
    [422, 'invalid_document'],
    [429, 'rate_limited'],
  ])('maps a %s response to the %s kind', async (status, kind) => {
    mockFetch.mockReturnValue(jsonResponse({ detail: 'document_too_large' }, status as number));

    const error = (await importAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error).toBeInstanceOf(DocumentUploadError);
    expect(error.kind).toBe(kind);
  });

  test('distinguishes the managed transport limit from the document cap', async () => {
    mockFetch.mockReturnValue(jsonResponse({ detail: 'managed_document_too_large' }, 413));
    const error = (await importAndCatch()) as InstanceType<typeof DocumentUploadError>;
    expect(error.kind).toBe('managed_too_large');
    expect(error.message).not.toContain(SENTINEL_BASE64);
  });

  test("carries a 429's Retry-After, so the run can wait out exactly that long", async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '17' }),
        json: () => Promise.resolve({ detail: 'rate_limit_exceeded' }),
      }),
    );

    const error = (await importAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(17);
    // One attempt: the client itself never retries the POST behind the run's back.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['absent', undefined],
    ['not a whole number of seconds', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['negative', '-4'],
  ])('reads no wait from a Retry-After that is %s', async (_label, value) => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers(value === undefined ? {} : { 'Retry-After': value }),
        json: () => Promise.resolve({ detail: 'rate_limit_exceeded' }),
      }),
    );

    const error = (await importAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error.retryAfterSeconds).toBeNull();
  });

  test('names no wait for a refusal that is not a rate limit', async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 422,
        headers: new Headers({ 'Retry-After': '5' }),
        json: () => Promise.resolve({ detail: 'invalid_document' }),
      }),
    );

    const error = (await importAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error.retryAfterSeconds).toBeNull();
  });

  test('never names the document in the error it raises', async () => {
    mockFetch.mockReturnValue(jsonResponse({ detail: 'document_too_large' }, 413));

    const error = (await importAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error.message).not.toContain(SENTINEL_BASE64);
    expect(error.message).not.toContain('seed.md');
  });

  test('allows a slow, large import the default fetch timeout would abort', () => {
    expect(UPLOAD_DOCUMENT_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
