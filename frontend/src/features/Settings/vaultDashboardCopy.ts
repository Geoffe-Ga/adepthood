/**
 * The words of the "Your vault" dashboard (#3776).
 *
 * Every closed vocabulary ``GET /vault/pipeline`` answers with -- a folder's
 * writer or the reason it has none, a document's stages, a pass's outcome and
 * failure code -- is worded here, and a token this app has no words for still
 * reads as a plain sentence. Nothing on the screen is ever the token itself.
 *
 * Quiet by design (NORTH-STAR "Default to quiet"): counts are counts, a finished
 * stage is a tick, and nothing here is a score, a streak or a percentage. An
 * empty folder is not a gap to fill; it says what would fill it, if anything.
 */
import type { SentSummary, VaultArea } from './vaultDashboardModel';

import type { StageRun, UploadReceipt, VaultFolder, VaultDocument } from '@/api';

type FolderReason = NonNullable<VaultFolder['writer_reason']>;
type DocumentStage = VaultDocument['stages'][number]['stage'];
type DocumentOutcome = VaultDocument['stages'][number]['outcome'];

export const VAULT_DASHBOARD_TITLE = 'Your vault';
export const VAULT_DASHBOARD_LEAD =
  'What has come in, what Creek has done with it, and which rooms of your vault are still quiet.';

export const VAULT_UPLOADS_HEADING = 'What came in';
export const VAULT_CREEK_HEADING = 'What Creek has done';
export const VAULT_DOCUMENTS_HEADING = 'Each file, step by step';
export const VAULT_SHAPE_HEADING = "Your vault's shape";

export const VAULT_UPDATE_NEEDED =
  'Your vault needs an update to show this. What it holds, and what Creek has done with each file, will show here once it has one.';
export const VAULT_DASHBOARD_NOT_CONNECTED =
  'There is no vault connected to this account, so there is nothing here to show yet. Where your writing lives is set up in Settings.';
export const VAULT_DASHBOARD_OPEN_SETTINGS = 'Where your writing lives';
export const VAULT_DASHBOARD_NOTHING_YET =
  'Nothing has come in yet. When you bring in writing you already have, each file will show here with where it landed.';
export const VAULT_DASHBOARD_NO_PASSES = 'No passes over your vault are recorded here yet.';
export const VAULT_DASHBOARD_READ_FAILURE =
  "Your vault's page didn't load just now. Your writing is safe; try again in a moment.";
export const VAULT_DASHBOARD_RETRY = 'Try again';

/** The entry point on Settings → Where your writing lives, and on a finished Seed run. */
export const VAULT_DASHBOARD_OPEN_LABEL = 'See what is in your vault';
export const SEED_SEE_WHERE_LABEL = 'See where everything went';

export const WRITERLESS_LINE = "Creek doesn't fill this one on its own";

const NOTHING_YET = 'Nothing here yet — ';

/** What fills an empty folder, by the writer Creek names for it. */
const WRITER_FILLS: Readonly<Record<string, string>> = {
  ingest: 'fills as you bring your writing in',
  'link.eddies': 'fills as your writing gathers around a theme',
  'link.threads': 'fills as a theme carries on through your writing over time',
  'classify.praxis': 'fills as practices surface in your writing',
  'generate.wavelength': 'fills as Creek maps the phases your writing moves through',
  save: 'fills when you keep something here',
  compile: 'fills as your writing is gathered by frequency',
  'generate.voice': 'fills as Creek learns how you write',
  'generate.lexicon': 'fills as Creek learns the words you return to',
  draft: 'fills when you draft in your own voice',
  'generate.decisions': 'fills as decisions surface in your writing',
  'generate.compost': "fills with what's been set aside to break down",
  'generate.paradox': 'fills as tensions in your writing come to light',
  'generate.synchronicity': 'fills as meaningful coincidences surface',
  'generate.unnamed': "fills with what doesn't have a name yet",
  authors: 'fills as you bring in the writing of others',
  'voice-drafts': 'fills as drafts in your voice are kept',
};
const WRITER_FILLS_FALLBACK = 'fills as Creek works through your writing';

/** Why a writerless folder stays as it is. */
const WRITERLESS_REASONS: Readonly<Record<FolderReason, string>> = {
  container: 'it holds the folders beneath it',
  owner_curated: "it's yours to fill",
  indexed_at_parent: 'its notes are gathered in the folder above it',
  template_example: 'it is an example that came with your vault',
};

/** "01-Fragments" -> "Fragments"; "External-Sources" -> "External Sources". */
function humaniseSegment(segment: string): string {
  const words = segment
    .replace(/^\d+-/u, '')
    .split('-')
    .map((word) => (word.toLowerCase() === 'ai' ? 'AI' : word))
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A folder path in words: ``04-Praxis/Daily`` -> "Praxis · Daily". */
export function folderLabel(path: string): string {
  return path.split('/').filter(Boolean).map(humaniseSegment).join(' · ');
}

/** The shelf every upload lands under, left out of "Landed in …" because it says nothing. */
const FRAGMENTS_SHELF = /^\d+-Fragments\//u;

/** "Landed in Writing · Substack", for a folder Creek reported. */
export function landedInLine(path: string): string {
  return `Landed in ${folderLabel(path.replace(FRAGMENTS_SHELF, ''))}`;
}

/** The quiet line under a folder's name, or null when its count says enough. */
export function folderNote(folder: VaultFolder): string | null {
  if (folder.writer === null) {
    const reason = folder.writer_reason ? WRITERLESS_REASONS[folder.writer_reason] : null;
    return reason ? `${WRITERLESS_LINE} — ${reason}.` : `${WRITERLESS_LINE}.`;
  }
  if (folder.count > 0) return null;
  return `${NOTHING_YET}${fillsWith(folder.writer)}.`;
}

/** A folder named within its area: ``01-Fragments/Writing/Substack`` -> "Writing · Substack". */
export function childLabel(path: string, areaPath: string): string {
  return folderLabel(path.slice(areaPath.length + 1));
}

/** What fills a folder, by its writer, as the rest of a "Nothing here yet — …" line. */
function fillsWith(writer: string | null): string {
  return (writer === null ? undefined : WRITER_FILLS[writer]) ?? WRITER_FILLS_FALLBACK;
}

/**
 * The area's one quiet line when it holds nothing: what fills it, once, or that
 * Creek does not fill it. Null when the area holds something -- its count and
 * summary say enough.
 */
export function areaNote(area: VaultArea): string | null {
  if (area.total > 0) return null;
  return area.hasWriter ? `${NOTHING_YET}${fillsWith(area.writer)}.` : `${WRITERLESS_LINE}.`;
}

/** "Writing · Substack 212, Journal 4": the filled folders of an area, on one line. */
export function areaSummary(area: VaultArea): string | null {
  const filled = area.children
    .filter((child) => child.count > 0)
    .map((child) => `${childLabel(child.path, area.path)} ${String(child.count)}`);
  return filled.length > 0 ? filled.join(', ') : null;
}

/** Folders whose notes are kept at the area's own level, said once for all of them. */
export function indexedLine(count: number): string {
  return count === 1
    ? 'Notes for its one folder are kept together here.'
    : `Notes for all ${String(count)} of its folders are kept together here.`;
}

/**
 * The line under one folder of an open area, only where it adds to the area's:
 * why Creek leaves it to you, or -- when it is filled differently from the
 * rest of its area -- what fills it.
 */
export function childNote(child: VaultFolder, area: VaultArea): string | null {
  if (child.writer === null) return folderNote(child);
  if (child.count > 0 || child.writer === area.writer) return null;
  return `${NOTHING_YET}${fillsWith(child.writer)}.`;
}

/** The area header's spoken name: its label and its count. */
export function areaAccessibilityLabel(label: string, total: number): string {
  return total > 0 ? `${label}, ${String(total)}` : `${label}, nothing yet`;
}

const DOCUMENT_STAGE_LABELS: Readonly<Record<DocumentStage, string>> = {
  ingested: 'Brought in',
  classified: 'Classified',
  praxis_scanned: 'Read for praxis',
  'linked:embeddings': 'Linked by meaning',
  'linked:temporal': 'Linked in time',
  'linked:eddies': 'Eddies',
  'linked:threads': 'Threads',
};

const DOCUMENT_OUTCOME_MARKS: Readonly<Record<DocumentOutcome, string>> = {
  ok: '✓',
  partial: 'partly',
  failed: "didn't finish",
};

export function documentStageLabel(stage: DocumentStage): string {
  return DOCUMENT_STAGE_LABELS[stage];
}

export function documentStageMark(outcome: DocumentOutcome): string {
  return DOCUMENT_OUTCOME_MARKS[outcome];
}

/** Where one stage's newest pass stands, as the screen reads it. */
export type PassState = 'done' | 'partly' | 'running' | 'unfinished' | 'unconfirmed';

/** One stage's newest pass, worded by :func:`passLine`. */
export interface PassSummary {
  stage: StageRun['stage'];
  state: PassState;
  emitted: number;
  failureCode: string | null;
}

const PASS_STAGE_LABELS: Readonly<Record<string, string>> = {
  classify: 'Classified',
  temporal: 'Linked in time',
  embeddings: 'Linked by meaning',
  eddies: 'Eddies',
  threads: 'Threads',
};
const PASS_STAGE_FALLBACK = 'Another pass';

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  request_key_rejected: 'your own provider key was refused',
  busy: 'your vault was busy, so it will try again',
};
const FAILURE_REASON_FALLBACK = 'Creek will try again on its next pass';

/** "Eddies ✓ (9)", "Linked in time — running", "Classified — didn't finish: …". */
export function passLine(pass: PassSummary): string {
  const label = PASS_STAGE_LABELS[pass.stage] ?? PASS_STAGE_FALLBACK;
  switch (pass.state) {
    case 'done':
      return pass.emitted > 0 ? `${label} ✓ (${String(pass.emitted)})` : `${label} ✓`;
    case 'running':
      return `${label} — running`;
    case 'partly':
      return `${label} — partly done; some writing is still to be sorted`;
    case 'unfinished': {
      const reason = pass.failureCode
        ? (FAILURE_REASONS[pass.failureCode] ?? FAILURE_REASON_FALLBACK)
        : FAILURE_REASON_FALLBACK;
      return `${label} — didn't finish: ${reason}.`;
    }
    case 'unconfirmed':
      return `${label} — may have finished; Creek didn't say`;
  }
}

/** The last pass's time, in the device's own clock. */
export function lastPassLine(time: string): string {
  return `Last pass ${time}`;
}

const RECEIPT_NOT_LANDED: Readonly<Record<string, string>> = {
  degraded: "Couldn't be confirmed",
  vault_unavailable: "Didn't land — your vault wasn't reachable",
  capability_unsupported: "Didn't land — your vault can't take files yet",
};
const RECEIPT_NOT_LANDED_FALLBACK = "Didn't land";

/** Whether a receipt is one the vault took. */
export function receiptLanded(receipt: UploadReceipt): boolean {
  return receipt.vault_status === 'accepted';
}

/** One file's line: where it landed, or why it didn't. */
export function receiptLine(receipt: UploadReceipt): string {
  if (receiptLanded(receipt)) {
    return receipt.landed_in ? landedInLine(receipt.landed_in) : 'In your vault';
  }
  return RECEIPT_NOT_LANDED[receipt.vault_status] ?? RECEIPT_NOT_LANDED_FALLBACK;
}

/** "A folder · 20 Nov" or "Files you chose · 20 Nov". */
export function batchHeading(kind: 'folder' | 'files', day: string): string {
  return `${kind === 'folder' ? 'A folder' : 'Files you chose'} · ${day}`;
}

/** "212 landed", "3 landed · 1 didn't". */
export function batchCountsLine(landed: number, notLanded: number): string {
  const head = `${String(landed)} landed`;
  return notLanded > 0 ? `${head} · ${String(notLanded)} didn't` : head;
}

/** The documents Creek would not name, counted and never named. */
export function withheldLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 more is above the privacy level shared here, so it is not named.'
    : `${String(count)} more are above the privacy level shared here, so they are not named.`;
}

/** The whole-corpus section (#3796): every file sent, and each stage over all of them. */
export const CORPUS_TOTALS_HEADING = 'Everything you sent in';
export const CORPUS_TOTALS_NOTHING_SENT = "You haven't sent anything in to your Corpus yet.";
export const CORPUS_TOTALS_NONE_WORKED = "Your Corpus hasn't worked through any of them yet.";

/** Digits grouped the way the device's own locale groups them: 1,240. */
const GROUPED = new Intl.NumberFormat();

function grouped(count: number): string {
  return GROUPED.format(count);
}

/** "1,180 of 1,240 files": a count beside the count it is out of, and nothing derived from them. */
export function filesOfLine(count: number, outOf: number): string {
  return `${grouped(count)} of ${grouped(outOf)} ${outOf === 1 ? 'file' : 'files'}`;
}

/** "1,240 of 1,243 files landed", over every file the account sent. */
export function sentLandedLine(landed: number, total: number): string {
  return `${filesOfLine(landed, total)} landed`;
}

/**
 * The files that did not land, each kind counted in its own words, or null when
 * every file landed. Turned away is a refusal of the file's type, not a
 * failure; unconfirmed is a file that may or may not be held.
 */
export function sentNotLandedLine(
  summary: Pick<SentSummary, 'turnedAway' | 'notLanded' | 'unconfirmed'>,
): string | null {
  const parts: string[] = [];
  if (summary.turnedAway > 0) {
    const whose = summary.turnedAway === 1 ? 'its' : 'their';
    parts.push(`${grouped(summary.turnedAway)} turned away for ${whose} file type`);
  }
  if (summary.notLanded > 0) parts.push(`${grouped(summary.notLanded)} didn't land`);
  if (summary.unconfirmed > 0) parts.push(`${grouped(summary.unconfirmed)} couldn't be confirmed`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** What a stage left behind, in the words a single file's stage uses, or null for nothing. */
export function stageLeftLine(partial: number, failed: number): string | null {
  const parts: string[] = [];
  if (partial > 0) parts.push(`${grouped(partial)} ${DOCUMENT_OUTCOME_MARKS.partial} done`);
  if (failed > 0) parts.push(`${grouped(failed)} ${DOCUMENT_OUTCOME_MARKS.failed}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
