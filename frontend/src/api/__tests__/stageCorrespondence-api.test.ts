/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, stages } from '../index';
import type { StageCorrespondence } from '../index';

/**
 * ``stages.correspondence`` reads ``GET /stages/correspondence`` (#2666): the
 * global, typed, visit-free list of each stage's canonical correspondences,
 * which the Journal chord reads its personas from when the Map has not loaded
 * the stages. Unlike ``GET /stages`` it records no program visit, so a page of
 * writing never counts as one.
 */

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const PURPLE: StageCorrespondence = {
  stage_key: 'purple',
  stage_number: 2,
  start_week: 3,
  category: 'Yes-And-Ness',
  aspect: 'Receptivity',
  spiral_dynamics_color: 'Purple',
  growing_up_stage: 'Magic',
  divine_gender_polarity: 'Divine Feminine',
  relationship_to_free_will: 'Pleasure Seeker',
  free_will_description: 'Behavior is steered from the Sacral.',
  provenance: {
    source_repo: 'Geoffe-Ga/aptitude-course',
    source_sha: '9d0f8962',
    source_path: 'google_docs/database_of_course_curriculum/APTITUDE Complete Map.csv',
    source_sha256: 'abc123',
    schema_version: '1.0.0',
    reconciled_at: '2026-09-30T00:00:00',
  },
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('stages.correspondence', () => {
  test('GETs /stages/correspondence, unpaginated, with the bearer token', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([PURPLE]));
    await stages.correspondence('tok');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/stages/correspondence');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  test('returns each stage as served', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([PURPLE]));
    const result = await stages.correspondence();
    expect(result).toEqual([PURPLE]);
  });

  test('accepts an unreconciled row, whose provenance is all null', async () => {
    const unreconciled = {
      ...PURPLE,
      provenance: {
        source_repo: null,
        source_sha: null,
        source_path: null,
        source_sha256: null,
        schema_version: null,
        reconciled_at: null,
      },
    };
    mockFetch.mockReturnValueOnce(jsonResponse([unreconciled]));
    const [stage] = await stages.correspondence();
    expect(stage?.provenance.source_sha).toBeNull();
  });

  test('rejects a row without its persona', async () => {
    const { relationship_to_free_will: _omit, ...withoutPersona } = PURPLE;
    void _omit;
    mockFetch.mockReturnValueOnce(jsonResponse([withoutPersona]));
    await expect(stages.correspondence()).rejects.toBeInstanceOf(ApiValidationError);
  });
});
