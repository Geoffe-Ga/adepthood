import type { StageRun, UploadReceipt, VaultFolder, VaultPipeline } from '@/api';

type StageTotals = NonNullable<NonNullable<VaultPipeline['vault']>['stage_totals']>;
type StageTotal = StageTotals['stages'][number];

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

/** One folder of Creek's listing, empty unless told otherwise. */
export function folder(
  path: string,
  writer: string | null,
  overrides: Partial<VaultFolder> = {},
): VaultFolder {
  return {
    path,
    count: 0,
    last_written_at: null,
    writer,
    writer_reason: writer === null ? 'container' : null,
    ...overrides,
  };
}

/**
 * A trimmed copy of Creek's 0.34 folder listing: enough areas to hold every
 * shape the dashboard groups -- a container with a filled child, a filled
 * area with no children, an empty area with one writer, an area whose folders
 * are indexed at its own level, an owner-curated area, and an area whose
 * children each have their own writer.
 */
export const SHAPE_FOLDERS: VaultFolder[] = [
  folder('01-Fragments', null),
  folder('01-Fragments/Notes', 'ingest'),
  folder('01-Fragments/Writing', 'ingest'),
  folder(SUBSTACK, 'ingest', { count: 212, last_written_at: LANDED_AT }),
  folder('03-Eddies', 'link.eddies', { count: 9, last_written_at: LANDED_AT }),
  folder('04-Praxis', null),
  folder('04-Praxis/Daily', 'classify.praxis'),
  folder('04-Praxis/Seasonal', 'classify.praxis'),
  folder('06-Frequencies', 'compile'),
  folder('06-Frequencies/F1-Agency', null, { writer_reason: 'indexed_at_parent' }),
  folder('06-Frequencies/F2-Receptivity', null, { writer_reason: 'indexed_at_parent' }),
  folder('09-Reference', null),
  folder('09-Reference/External-Sources', null, { writer_reason: 'owner_curated' }),
  folder('10-Liminal', null),
  folder('10-Liminal/Compost', 'generate.compost'),
  folder('10-Liminal/Paradoxes', 'generate.paradox'),
  folder('11-Other-Authors', 'authors'),
  folder('11-Other-Authors/example-author', null, { writer_reason: 'template_example' }),
];

export const VAULT_SNAPSHOT: NonNullable<VaultPipeline['vault']> = {
  folders: SHAPE_FOLDERS,
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
  stage_totals: null,
};

/** How many files the populated whole-corpus fixture holds: four digits, so grouping shows. */
export const TOTALS_DOCUMENTS = 1240;

function stageTotal(
  stage: StageTotal['stage'],
  covered: number,
  left: Partial<Pick<StageTotal, 'partial' | 'failed'>> = {},
): StageTotal {
  return { stage, covered, partial: 0, failed: 0, ...left };
}

/**
 * Creek's 0.37 whole-corpus stage counts (#3796), all seven stages in pipeline
 * order: two finished, one that left some partly done, one that left some
 * unfinished, one that left both, one under way and one not begun.
 */
export const STAGE_TOTALS: StageTotals = {
  documents: TOTALS_DOCUMENTS,
  stages: [
    stageTotal('ingested', TOTALS_DOCUMENTS),
    stageTotal('classified', 1180, { partial: 60 }),
    stageTotal('praxis_scanned', TOTALS_DOCUMENTS),
    stageTotal('linked:embeddings', 900, { failed: 3 }),
    stageTotal('linked:temporal', 1100, { partial: 12, failed: 2 }),
    stageTotal('linked:eddies', 64),
    stageTotal('linked:threads', 0),
  ],
};

/** Every receipt of an account that sent 1,243 files, three of which did not land. */
export const SENT_TOTALS: VaultPipeline['totals']['sent'] = {
  accepted: TOTALS_DOCUMENTS,
  vault_unavailable: 0,
  capability_unsupported: 0,
  degraded: 0,
  unsupported_source: 3,
};

export function pipelineAnswer(overrides: Partial<VaultPipeline> = {}): VaultPipeline {
  return {
    recent_uploads: [receipt()],
    next_before: null,
    stage_runs: [stageRun()],
    totals: {
      sent: {
        accepted: 1,
        vault_unavailable: 0,
        capability_unsupported: 0,
        degraded: 0,
        unsupported_source: 0,
      },
    },
    vault: VAULT_SNAPSHOT,
    vault_status: 'ok',
    vault_unreachable: false,
    ...overrides,
  };
}
