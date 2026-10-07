/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  essayResponseSchema,
  marginaliaSchema,
  resonanceResponseSchema,
  voiceDraftSchema,
} from '../schemas';

// A note as a server from before #3062 sends it: no provenance fields at all.
const LEGACY_NOTE = {
  id: 1,
  journal_entry_id: 2,
  kind: 'theme',
  anchor_start: 0,
  anchor_end: 4,
  anchor_text: 'walk',
  note: 'A note.',
  essay: null,
  essay_generated_at: null,
  status: 'active',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

const PASS = {
  marginalia: [],
  suggestions: [],
  remaining_messages: 3,
  remaining_balance: 0,
  monthly_reset_date: '2026-11-01T00:00:00Z',
};

const RECEIPT = { source: 'demo', provider: 'stub', model: 'stub', receipt_version: 1 };
const PROVENANCE = {
  notes: RECEIPT,
  detection: { source: 'none', provider: null, model: null, receipt_version: 1 },
  detection_checked: true,
  paid_by: 'free',
};

describe('provenance schemas fail safe (#3062)', () => {
  it('parses a legacy note with every provenance field unset', () => {
    const parsed = marginaliaSchema.parse(LEGACY_NOTE);
    expect(parsed.source ?? null).toBeNull();
    expect(parsed.essay_source ?? null).toBeNull();
  });

  it('parses an unknown or malformed source to null rather than failing the note', () => {
    const parsed = marginaliaSchema.parse({
      ...LEGACY_NOTE,
      source: 'mystery',
      source_provider: 'ollama',
      essay_source: 42,
      receipt_version: 'one',
    });
    expect(parsed.source).toBeNull();
    expect(parsed.source_provider).toBeNull();
    expect(parsed.essay_source).toBeNull();
    expect(parsed.receipt_version).toBeNull();
    expect(parsed.note).toBe('A note.');
  });

  it('keeps a recorded source', () => {
    expect(marginaliaSchema.parse({ ...LEGACY_NOTE, source: 'creek_vault' }).source).toBe(
      'creek_vault',
    );
  });

  it('round-trips a valid pass provenance', () => {
    const parsed = resonanceResponseSchema.parse({ ...PASS, provenance: PROVENANCE });
    expect(parsed.provenance).toEqual(PROVENANCE);
  });

  it('reads a garbage provenance as null, and an absent one as unset', () => {
    expect(resonanceResponseSchema.parse({ ...PASS, provenance: 'garbage' }).provenance).toBeNull();
    expect(
      resonanceResponseSchema.parse({ ...PASS, provenance: { notes: 'x' } }).provenance,
    ).toBeNull();
    expect(resonanceResponseSchema.parse(PASS).provenance ?? null).toBeNull();
  });

  it('carries the letter source on an essay and on a voice draft', () => {
    const essay = essayResponseSchema.parse({
      ...LEGACY_NOTE,
      essay_source: 'app_provider',
      remaining_messages: 1,
      remaining_balance: 0,
      monthly_reset_date: '2026-11-01T00:00:00Z',
    });
    expect(essay.essay_source).toBe('app_provider');
    const draft = voiceDraftSchema.parse({
      marginalia_id: 1,
      journal_entry_id: 2,
      kind: 'theme',
      anchor_text: 'walk',
      essay: 'A letter.',
      essay_generated_at: '2026-10-01T00:00:00Z',
      essay_source: 'demo',
    });
    expect(draft.essay_source).toBe('demo');
  });
});
