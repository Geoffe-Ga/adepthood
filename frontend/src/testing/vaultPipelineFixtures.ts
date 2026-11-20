import type { StageRun, UploadReceipt, VaultPipeline } from '@/api';

const FILENAME = 'on-attention.html';
const SUBSTACK = '01-Fragments/Writing/Substack';
const LANDED_AT = '2026-11-20T17:02:11Z';

/**
 * ``GET /vault/pipeline`` answers for the "Your vault" tests (#3776), each a
 * whole valid answer with any field overridden. The vault half is shaped after
 * Creek's published 0.34 success cell, trimmed to the folders the tests read.
 */

export function receipt(overrides: Partial<UploadReceipt> = {}): UploadReceipt {
  return {
    id: 1,
    filename: FILENAME,
    batch: null,
    destination: 'vault',
    vault_status: 'accepted',
    vault_ref: 'frag-1',
    landed_in: SUBSTACK,
    landed_at: LANDED_AT,
    ...overrides,
  };
}

export function stageRun(overrides: Partial<StageRun> = {}): StageRun {
  return {
    trigger: 'document_import',
    stage: 'classify',
    outcome: 'completed',
    failure_code: null,
    fragments_seen: 212,
    emitted: 212,
    fragments_lost: 0,
    ran_at: '2026-11-20T17:04:00Z',
    ...overrides,
  };
}

export const VAULT_SNAPSHOT: NonNullable<VaultPipeline['vault']> = {
  folders: [
    {
      path: '01-Fragments',
      count: 0,
      last_written_at: null,
      writer: null,
      writer_reason: 'container',
    },
    {
      path: SUBSTACK,
      count: 212,
      last_written_at: LANDED_AT,
      writer: 'ingest',
      writer_reason: null,
    },
    {
      path: '03-Eddies',
      count: 9,
      last_written_at: LANDED_AT,
      writer: 'link.eddies',
      writer_reason: null,
    },
    {
      path: '04-Praxis/Daily',
      count: 0,
      last_written_at: null,
      writer: 'classify.praxis',
      writer_reason: null,
    },
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
      filename: FILENAME,
      landed_in: SUBSTACK,
      fragment_count: 1,
      stages: [
        { stage: 'ingested', at: LANDED_AT, outcome: 'ok' },
        { stage: 'classified', at: '2026-11-20T17:03:40Z', outcome: 'ok' },
        { stage: 'linked:eddies', at: '2026-11-20T17:05:02Z', outcome: 'partial' },
      ],
    },
  ],
  documents_withheld: 1,
  jobs: [],
};

export function pipelineAnswer(overrides: Partial<VaultPipeline> = {}): VaultPipeline {
  return {
    recent_uploads: [receipt()],
    next_before: null,
    stage_runs: [stageRun()],
    vault: VAULT_SNAPSHOT,
    vault_status: 'ok',
    vault_unreachable: false,
    ...overrides,
  };
}
