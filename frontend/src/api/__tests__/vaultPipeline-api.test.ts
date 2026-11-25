/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, vault } from '../index';
import type { VaultPipeline } from '../index';

/**
 * The client half of the "Your vault" dashboard read (#3775, #3776).
 *
 * ``GET /vault/pipeline`` is always a 200 that says, in ``vault_status``, why
 * Creek's half is missing when it is. Worth a test rather than a type: the
 * whole shape is validated at the edge, the route is spelled with no trailing
 * slash, the receipt cursor travels as ``?before=``, and a vocabulary the
 * client does not know is a validation error rather than a blank row.
 */

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const RECEIPT_CURSOR = 41;

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
  });
}

const ANSWER: VaultPipeline = {
  recent_uploads: [
    {
      id: 42,
      filename: 'on-attention.html',
      batch: 'batch-of-one-folder',
      destination: 'vault',
      vault_status: 'accepted',
      vault_ref: 'frag-1',
      landed_in: '01-Fragments/Writing/Substack',
      landed_at: '2026-11-20T17:02:11Z',
    },
  ],
  next_before: null,
  totals: { sent: { accepted: 1240, degraded: 0, unsupported_source: 3 } },
  stage_runs: [
    {
      trigger: 'document_import',
      stage: 'eddies',
      outcome: 'completed',
      failure_code: null,
      fragments_seen: 212,
      emitted: 9,
      fragments_lost: 0,
      ran_at: '2026-11-20T17:04:00Z',
    },
  ],
  vault: {
    folders: [
      {
        path: '09-Reference/External-Sources',
        count: 0,
        last_written_at: null,
        writer: null,
        writer_reason: 'owner_curated',
      },
    ],
    documents: [
      {
        filename: 'on-attention.html',
        landed_in: '01-Fragments/Writing/Substack',
        fragment_count: 1,
        stages: [{ stage: 'linked:eddies', at: '2026-11-20T17:05:02Z', outcome: 'partial' }],
      },
    ],
    documents_withheld: 1,
    jobs: [
      {
        kind: 'link',
        method: 'embeddings',
        state: 'running',
        failure_code: null,
        updated_at: '2026-11-20T17:05:30Z',
      },
    ],
    stage_totals: {
      documents: 1240,
      stages: [
        { stage: 'ingested', covered: 1240, partial: 0, failed: 0 },
        { stage: 'linked:eddies', covered: 0, partial: 1240, failed: 0 },
      ],
    },
  },
  vault_status: 'ok',
  vault_unreachable: false,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('vault.pipeline', () => {
  test('GETs /vault/pipeline with no trailing slash and returns the whole answer', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(ANSWER));

    const result = await vault.pipeline({}, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/vault/pipeline');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result).toEqual(ANSWER);
  });

  test('sends the receipt cursor as ?before=', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...ANSWER, recent_uploads: [] }));

    await vault.pipeline({ before: RECEIPT_CURSOR }, 'tok');

    expect(mockFetch.mock.calls[0][0]).toBe(`http://test/vault/pipeline?before=${RECEIPT_CURSOR}`);
  });

  test('keeps a vault that needs an update as an answer, with no vault half', async () => {
    const older = { ...ANSWER, vault: null, vault_status: 'update_needed' };
    mockFetch.mockReturnValueOnce(jsonResponse(older));

    await expect(vault.pipeline({}, 'tok')).resolves.toEqual(older);
  });

  test('keeps a vault that predates stage totals, with the rest of its half', async () => {
    const earlier = { ...ANSWER, vault: { ...ANSWER.vault, stage_totals: null } };
    mockFetch.mockReturnValueOnce(jsonResponse(earlier));

    await expect(vault.pipeline({}, 'tok')).resolves.toEqual(earlier);
  });

  test.each([
    ['a vault status it does not know', { vault_status: 'sleeping' }],
    [
      'a writerless reason it does not know',
      {
        vault: {
          ...ANSWER.vault,
          folders: [
            {
              path: 'x',
              count: 0,
              last_written_at: null,
              writer: null,
              writer_reason: 'mystery',
            },
          ],
        },
      },
    ],
    ['a negative count', { stage_runs: [{ ...ANSWER.stage_runs[0], emitted: -1 }] }],
    ['a negative count of files sent', { totals: { sent: { accepted: -1 } } }],
    ['an answer with no totals', { totals: undefined }],
    [
      'a stage total for a stage it does not know',
      {
        vault: {
          ...ANSWER.vault,
          stage_totals: {
            documents: 1,
            stages: [{ stage: 'published', covered: 1, partial: 0, failed: 0 }],
          },
        },
      },
    ],
  ])('raises ApiValidationError on %s', async (_label, drift) => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...ANSWER, ...drift }));

    const err = await vault.pipeline({}, 'tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});
