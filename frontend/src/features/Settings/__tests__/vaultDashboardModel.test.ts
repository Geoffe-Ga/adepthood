/* eslint-env jest */
/* global describe, test, expect */
import type { StageRun, UploadReceipt, VaultPipeline } from '@/api';
import {
  groupReceipts,
  isPipelineBusy,
  landedFolderFor,
  passSummary,
} from '@/features/Settings/vaultDashboardModel';

/**
 * The pure half of the "Your vault" dashboard (#3776): how receipts group into
 * imports, which pass of each stage is the one to show, when the screen should
 * keep re-reading, and which folder a Seed row may honestly claim it landed in.
 */

const TZ = 'UTC';

function receipt(overrides: Partial<UploadReceipt> = {}): UploadReceipt {
  return {
    id: 1,
    filename: 'on-attention.html',
    batch: null,
    destination: 'vault',
    vault_status: 'accepted',
    vault_ref: 'frag-1',
    landed_in: '01-Fragments/Writing/Substack',
    landed_at: '2026-11-20T17:02:11Z',
    ...overrides,
  };
}

function run(overrides: Partial<StageRun> = {}): StageRun {
  return {
    trigger: 'document_import',
    stage: 'classify',
    outcome: 'completed',
    failure_code: null,
    fragments_seen: 10,
    emitted: 10,
    fragments_lost: 0,
    ran_at: '2026-11-20T17:04:00Z',
    ...overrides,
  };
}

function answer(overrides: Partial<VaultPipeline> = {}): VaultPipeline {
  return {
    recent_uploads: [],
    next_before: null,
    stage_runs: [],
    vault: null,
    vault_status: 'update_needed',
    vault_unreachable: false,
    ...overrides,
  };
}

describe('groupReceipts', () => {
  test('keeps a folder import together and counts what landed and what did not', () => {
    const groups = groupReceipts(
      [
        receipt({ id: 3, batch: 'b1' }),
        receipt({ id: 2, batch: 'b1', vault_status: 'degraded', landed_in: null }),
        receipt({ id: 1, batch: 'b1' }),
      ],
      TZ,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'folder', day: '20 Nov', landed: 2, notLanded: 1 });
    expect(groups[0]?.receipts.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  test('gathers single files by the day they came in, apart from folder imports', () => {
    const groups = groupReceipts(
      [
        receipt({ id: 4 }),
        receipt({ id: 3, batch: 'b1' }),
        receipt({ id: 2 }),
        receipt({ id: 1, landed_at: '2026-11-19T09:00:00Z' }),
      ],
      TZ,
    );

    expect(groups.map((g) => [g.kind, g.day, g.receipts.map((r) => r.id)])).toEqual([
      ['files', '20 Nov', [4, 2]],
      ['folder', '20 Nov', [3]],
      ['files', '19 Nov', [1]],
    ]);
  });
});

describe('passSummary', () => {
  test('shows the newest pass of each stage, in the order Creek runs them', () => {
    const passes = passSummary(
      [
        run({ stage: 'threads', emitted: 4, ran_at: '2026-11-20T17:06:00Z' }),
        run({ stage: 'eddies', emitted: 9 }),
        run({ stage: 'classify', emitted: 212 }),
        run({ stage: 'classify', outcome: 'failed', ran_at: '2026-11-19T10:00:00Z' }),
      ],
      [],
    );

    expect(passes.map((p) => [p.stage, p.state, p.emitted])).toEqual([
      ['classify', 'done', 212],
      ['eddies', 'done', 9],
      ['threads', 'done', 4],
    ]);
  });

  test.each([
    ['queued', 'running'],
    ['attempted', 'running'],
    ['incomplete', 'partly'],
    ['failed', 'unfinished'],
    ['ambiguous', 'unconfirmed'],
    ['something-new', 'unconfirmed'],
  ])('reads a %s pass as %s', (outcome, state) => {
    expect(passSummary([run({ outcome })], [])[0]?.state).toBe(state);
  });

  test("marks a stage running while one of the vault's own jobs for it is going", () => {
    const passes = passSummary(
      [run({ stage: 'embeddings' })],
      [
        {
          kind: 'link',
          method: 'embeddings',
          state: 'running',
          failure_code: null,
          updated_at: '2026-11-20T17:05:30Z',
        },
        {
          kind: 'classification',
          method: 'semantic',
          state: 'queued',
          failure_code: null,
          updated_at: '2026-11-20T17:05:30Z',
        },
      ],
    );

    expect(passes.map((p) => [p.stage, p.state])).toEqual([
      ['classify', 'running'],
      ['embeddings', 'running'],
    ]);
  });
});

describe('isPipelineBusy', () => {
  test('is busy only while a pass or a vault job is still going', () => {
    expect(isPipelineBusy(answer())).toBe(false);
    expect(isPipelineBusy(answer({ stage_runs: [run()] }))).toBe(false);
    expect(isPipelineBusy(answer({ stage_runs: [run({ outcome: 'attempted' })] }))).toBe(true);
    expect(
      isPipelineBusy(
        answer({
          vault_status: 'ok',
          vault: {
            folders: [],
            documents: [],
            documents_withheld: 0,
            jobs: [
              {
                kind: 'link',
                method: 'eddies',
                state: 'succeeded',
                failure_code: null,
                updated_at: '2026-11-20T17:05:30Z',
              },
            ],
          },
        }),
      ),
    ).toBe(false);
  });

  test('is never busy without an answer', () => {
    expect(isPipelineBusy(null)).toBe(false);
  });
});

describe('landedFolderFor', () => {
  test("names the folder a row's file landed in, by its own name or its path's last part", () => {
    const receipts = [
      receipt(),
      receipt({ id: 2, filename: 'Index.md', landed_in: '01-Fragments/Notes' }),
    ];

    expect(landedFolderFor(receipts, 'on-attention.html')).toBe('01-Fragments/Writing/Substack');
    expect(landedFolderFor(receipts, 'Field Notes/Work/Index.md')).toBe('01-Fragments/Notes');
  });

  test('claims nothing when the name is unknown, unplaced, refused, or placed in two folders', () => {
    const receipts = [
      receipt({ filename: 'a.md', landed_in: null }),
      receipt({ filename: 'b.md', vault_status: 'degraded' }),
      receipt({ filename: 'Index.md', landed_in: '01-Fragments/Notes' }),
      receipt({ filename: 'Index.md', landed_in: '01-Fragments/Journal' }),
    ];

    expect(landedFolderFor(receipts, 'missing.md')).toBeNull();
    expect(landedFolderFor(receipts, 'a.md')).toBeNull();
    expect(landedFolderFor(receipts, 'b.md')).toBeNull();
    expect(landedFolderFor(receipts, 'Index.md')).toBeNull();
  });

  test('agrees with itself when the same file landed in the same folder twice', () => {
    const receipts = [receipt({ id: 1 }), receipt({ id: 2 })];

    expect(landedFolderFor(receipts, 'on-attention.html')).toBe('01-Fragments/Writing/Substack');
  });
});
