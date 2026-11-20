/**
 * The pure half of the "Your vault" dashboard (#3776): grouping receipts into
 * the imports they came in, picking the pass of each stage worth showing,
 * deciding whether the screen should keep re-reading, and naming the folder a
 * Seed row may honestly say it landed in.
 */
import type { PassState, PassSummary } from './vaultDashboardCopy';
import { receiptLanded } from './vaultDashboardCopy';

import type { StageRun, UploadReceipt, VaultPipeline } from '@/api';
import { dayKeyInTZ } from '@/utils/dateUtils';

type VaultJob = NonNullable<VaultPipeline['vault']>['jobs'][number];

/** One import as the dashboard lists it: a folder's batch, or a day's single files. */
export interface ReceiptGroup {
  key: string;
  kind: 'folder' | 'files';
  /** "20 Nov", in the device's own time zone. */
  day: string;
  receipts: UploadReceipt[];
  landed: number;
  notLanded: number;
}

/** "20 Nov" for an instant, in ``timeZone``. */
export function shortDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(
    new Date(instant),
  );
}

/**
 * Receipts grouped the way they came in, newest group first: every document of
 * one folder import together (its opaque ``batch``), and single files gathered
 * by the day they arrived. The receipts keep the server's newest-first order.
 */
export function groupReceipts(
  receipts: readonly UploadReceipt[],
  timeZone: string,
): ReceiptGroup[] {
  const groups = new Map<string, ReceiptGroup>();
  for (const receipt of receipts) {
    const kind = receipt.batch === null ? 'files' : 'folder';
    const key =
      receipt.batch === null
        ? `files:${dayKeyInTZ(receipt.landed_at, timeZone)}`
        : `folder:${receipt.batch}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        kind,
        day: shortDay(receipt.landed_at, timeZone),
        receipts: [],
        landed: 0,
        notLanded: 0,
      };
      groups.set(key, group);
    }
    group.receipts.push(receipt);
    if (receiptLanded(receipt)) group.landed += 1;
    else group.notLanded += 1;
  }
  return [...groups.values()];
}

/** The order Creek runs its stages in; a stage this app does not know goes last. */
const STAGE_ORDER: readonly string[] = ['classify', 'temporal', 'embeddings', 'eddies', 'threads'];

const RUN_STATES: Readonly<Record<string, PassState>> = {
  completed: 'done',
  incomplete: 'partly',
  queued: 'running',
  attempted: 'running',
  failed: 'unfinished',
};

const RUNNING_OUTCOMES: ReadonlySet<string> = new Set(['queued', 'attempted']);
const RUNNING_JOB_STATES: ReadonlySet<VaultJob['state']> = new Set(['queued', 'running']);

/** The pass stage a vault job is doing: classification, or the linker it names. */
function jobStage(job: VaultJob): string {
  return job.kind === 'classification' ? 'classify' : job.method;
}

function stageRank(stage: string): number {
  const at = STAGE_ORDER.indexOf(stage);
  return at === -1 ? STAGE_ORDER.length : at;
}

/**
 * The newest pass of each stage, in the order Creek runs them. ``runs`` arrive
 * newest first, so the first of each stage is the one shown. A stage the vault
 * itself reports a job going for reads as running whatever its last pass said.
 */
export function passSummary(runs: readonly StageRun[], jobs: readonly VaultJob[]): PassSummary[] {
  const passes = new Map<string, PassSummary>();
  for (const run of runs) {
    if (passes.has(run.stage)) continue;
    passes.set(run.stage, {
      stage: run.stage,
      state: RUN_STATES[run.outcome] ?? 'unconfirmed',
      emitted: run.emitted,
      failureCode: run.failure_code,
    });
  }
  for (const job of jobs) {
    if (!RUNNING_JOB_STATES.has(job.state)) continue;
    const stage = jobStage(job);
    const known = passes.get(stage);
    passes.set(stage, {
      stage,
      state: 'running',
      emitted: known?.emitted ?? 0,
      failureCode: null,
    });
  }
  return [...passes.values()].sort((a, b) => stageRank(a.stage) - stageRank(b.stage));
}

/**
 * Whether anything is still going: a pass adepthood started that has not
 * answered, or a job the vault reports queued or running. The dashboard
 * re-reads only while this holds.
 */
export function isPipelineBusy(answer: VaultPipeline | null): boolean {
  if (answer === null) return false;
  if (answer.stage_runs.some((run) => RUNNING_OUTCOMES.has(run.outcome))) return true;
  return (answer.vault?.jobs ?? []).some((job) => RUNNING_JOB_STATES.has(job.state));
}

/**
 * The folder a Seed row's file landed in, or null when it cannot honestly be said.
 *
 * A row is named by its file, or by its path within a folder import; a receipt
 * keeps only the file's own name (never the folder's), so the last part of the
 * row's name is what matches. Only a receipt the vault took, and whose folder
 * Creek reported, counts -- and if two such receipts of one name sit in
 * different folders, the row could be either, so it claims neither.
 */
export function landedFolderFor(
  receipts: readonly UploadReceipt[],
  rowName: string,
): string | null {
  const filename = rowName.slice(rowName.lastIndexOf('/') + 1);
  const folders = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.filename !== filename || !receiptLanded(receipt)) continue;
    if (receipt.landed_in !== null) folders.add(receipt.landed_in);
  }
  return folders.size === 1 ? ([...folders][0] ?? null) : null;
}
