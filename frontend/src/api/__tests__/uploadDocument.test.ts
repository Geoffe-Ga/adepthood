/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { DocumentUploadError, journal, UPLOAD_DOCUMENT_TIMEOUT_MS } from '../index';
import { uploadDocumentSchema } from '../schemas';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

/** Distinctive fixture so a leak into a log or an error message is unmistakable. */
const SENTINEL_BASE64 = 'WlpaWl9TRU5USU5FTF9ET0NVTUVOVF9aWlpa';

const ACCEPTED_BODY = {
  status: 'accepted',
  vault_ref: 'frag-42',
  tags: ['reflection'],
  message: 'Your document is in your vault.',
};

function jsonResponse(data: unknown, status = 202) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('journal.uploadDocument request shape', () => {
  test('POSTs /journal/upload with a snake_case JSON body and bearer auth', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ACCEPTED_BODY));

    await journal.uploadDocument(
      { filename: 'seed.md', contentBase64: SENTINEL_BASE64, classification: 'personal' },
      'tok',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/journal/upload');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      filename: 'seed.md',
      content_base64: SENTINEL_BASE64,
      classification: 'personal',
    });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  test('sends JSON, never a multipart surface', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ACCEPTED_BODY));

    await journal.uploadDocument(
      { filename: 'seed.md', contentBase64: SENTINEL_BASE64, classification: 'intimate' },
      'tok',
    );

    const [, init] = mockFetch.mock.calls[0];
    expect(typeof init.body).toBe('string');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  test('forwards the chosen classification unchanged, intimate included', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ACCEPTED_BODY));

    await journal.uploadDocument(
      { filename: 'seed.md', contentBase64: SENTINEL_BASE64, classification: 'intimate' },
      'tok',
    );

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });
});

describe('journal.uploadDocument response', () => {
  test('resolves with the vault outcome on a 202', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ACCEPTED_BODY));

    const result = await journal.uploadDocument(
      { filename: 'seed.md', contentBase64: SENTINEL_BASE64, classification: 'personal' },
      'tok',
    );

    expect(result).toEqual(ACCEPTED_BODY);
  });

  test.each(['accepted', 'vault_unavailable', 'capability_unsupported', 'degraded'])(
    'validates the %s outcome',
    (status) => {
      const parsed = uploadDocumentSchema.parse({
        status,
        vault_ref: null,
        tags: [],
        message: 'something honest',
      });
      expect(parsed.status).toBe(status);
    },
  );

  test('rejects a status the client has no rendering for', () => {
    expect(() =>
      uploadDocumentSchema.parse({ status: 'quarantined', tags: [], message: 'hm' }),
    ).toThrow();
  });
});

describe('journal.uploadDocument failures', () => {
  async function uploadAndCatch(): Promise<unknown> {
    return journal
      .uploadDocument(
        { filename: 'seed.md', contentBase64: SENTINEL_BASE64, classification: 'personal' },
        'tok',
      )
      .catch((e: unknown) => e);
  }

  test.each([
    [413, 'too_large'],
    [422, 'invalid_document'],
    [429, 'rate_limited'],
  ])('maps a %s response to the %s kind', async (status, kind) => {
    mockFetch.mockReturnValue(jsonResponse({ detail: 'document_too_large' }, status as number));

    const error = (await uploadAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error).toBeInstanceOf(DocumentUploadError);
    expect(error.kind).toBe(kind);
  });

  test('never names the document in the error it raises', async () => {
    mockFetch.mockReturnValue(jsonResponse({ detail: 'document_too_large' }, 413));

    const error = (await uploadAndCatch()) as InstanceType<typeof DocumentUploadError>;

    expect(error.message).not.toContain(SENTINEL_BASE64);
    expect(error.message).not.toContain('seed.md');
  });

  test('allows a slow, large upload the default fetch timeout would abort', () => {
    expect(UPLOAD_DOCUMENT_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
