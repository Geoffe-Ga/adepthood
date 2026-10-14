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
    ).toEqual({ notes: null, detection: null, detection_checked: null, paid_by: null });
    expect(resonanceResponseSchema.parse(PASS).provenance ?? null).toBeNull();
  });

  it('keeps a valid detection and payer when only the notes receipt is malformed', () => {
    const parsed = resonanceResponseSchema.parse({
      ...PASS,
      provenance: { ...PROVENANCE, notes: { ...RECEIPT, model: { forged: true } } },
    });
    expect(parsed.provenance?.notes).toBeNull();
    expect(parsed.provenance?.detection).toEqual(PROVENANCE.detection);
    expect(parsed.provenance?.paid_by).toBe('free');
  });

  it.each([
    { ...RECEIPT, receipt_version: 2 },
    { ...RECEIPT, source: 'creek_vault', provider: 'openai', model: null },
    { ...RECEIPT, source: 'app_provider', provider: 'stub' },
    { ...RECEIPT, source: 'app_provider', provider: 'ollama' },
    { ...RECEIPT, source: 'none', provider: null },
  ])(
    'refuses unsupported or contradictory operation metadata without losing its sibling: %p',
    (notes) => {
      const parsed = resonanceResponseSchema.parse({
        ...PASS,
        provenance: { ...PROVENANCE, notes },
      });
      expect(parsed.provenance?.notes).toBeNull();
      expect(parsed.provenance?.detection).toEqual(PROVENANCE.detection);
    },
  );

  it.each([
    { source: 'app_provider', source_provider: 'stub', source_model: 'stub', receipt_version: 1 },
    { source: 'creek_vault', source_provider: 'openai', source_model: null, receipt_version: 1 },
    { source: 'app_provider', source_provider: 'openai', source_model: null, receipt_version: 2 },
    { source: 'app_provider', source_provider: 'ollama', source_model: null, receipt_version: 1 },
  ])(
    'keeps prose and the independent letter source when note metadata is invalid: %p',
    (metadata) => {
      const parsed = marginaliaSchema.parse({ ...LEGACY_NOTE, ...metadata, essay_source: 'demo' });
      expect(parsed.source).toBeNull();
      expect(parsed.note).toBe('A note.');
      expect(parsed.essay_source).toBe('demo');
    },
  );

  it('accepts an app-provider receipt whose provider and model were not recorded', () => {
    const notes = { source: 'app_provider', provider: null, model: null, receipt_version: 1 };
    expect(
      resonanceResponseSchema.parse({ ...PASS, provenance: { ...PROVENANCE, notes } }).provenance
        ?.notes,
    ).toEqual(notes);
  });

  it('keeps a valid notes receipt when completion metadata is malformed', () => {
    const parsed = resonanceResponseSchema.parse({
      ...PASS,
      provenance: { ...PROVENANCE, detection: { ...RECEIPT, receipt_version: 2 } },
    });
    expect(parsed.provenance?.notes).toEqual(RECEIPT);
    expect(parsed.provenance?.detection).toBeNull();
    expect(parsed.provenance?.paid_by).toBe('free');
  });

  it.each(['wallet', 'own_key'])(
    'does not label a recorded demo as paid real inference: %s',
    (paid_by) => {
      const parsed = resonanceResponseSchema.parse({
        ...PASS,
        provenance: { ...PROVENANCE, paid_by },
      });
      expect(parsed.provenance?.notes).toEqual(RECEIPT);
      expect(parsed.provenance?.paid_by).toBeNull();
    },
  );

  it('uses the server model limit in Unicode code points and preserves independent essay source', () => {
    const metadata = {
      source: 'app_provider',
      source_provider: 'openai',
      receipt_version: 1,
      essay_source: 'creek_vault',
    };
    expect(
      marginaliaSchema.parse({ ...LEGACY_NOTE, ...metadata, source_model: '🌱'.repeat(64) })
        .source_model,
    ).toBe('🌱'.repeat(64));
    const oversized = marginaliaSchema.parse({
      ...LEGACY_NOTE,
      ...metadata,
      source_model: '🌱'.repeat(65),
    });
    expect(oversized.source).toBeNull();
    expect(oversized.note).toBe('A note.');
    expect(oversized.essay_source).toBe('creek_vault');
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
