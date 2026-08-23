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
