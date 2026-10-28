/**
 * One document's whole journey: refuse it on device if it cannot be read or the
 * endpoint would not take it, otherwise encode it and hand it over, and answer
 * with the single settled status the run renders.
 *
 * **One route, and the destination is the server's answer.** `POST
 * /corpus/import` takes the document to the account's vault, or — for an
 * account the server finds no vault for — keeps nothing and answers
 * `vault_required` (#3016), so this module asks once and reads which answered. It never checks for a vault
 * itself and never re-sends a corpus answer to the vault surface: a second
 * caller with overlapping meaning is a second answer to a question the server
 * has already settled, and the day the two disagree the person is told
 * something untrue about where their writing is.
 *
 * Never throws. A seeding run is usually many documents at once, and one that
 * cannot be sent must cost the others nothing — so every failure becomes a
 * status here rather than an exception the loop has to survive.
 *
 * PRIVACY: the encoded document exists only inside this call, goes only into
 * the request body, and is never logged. The returned status carries none of it.
 */
import type { PickedDocument } from './pickSeedDocuments';
import { readSeedDocument } from './readSeedDocument';
import type { CorpusSeedStatus, SettledSeedStatus, VaultSeedStatus } from './seedRun';

import {
  corpus,
  DocumentUploadError,
  type CorpusImportStatusT,
  type DocumentImportT,
  type JournalClassification,
  type VaultUploadStatusT,
} from '@/api';
import { isDeviceKnownOffline } from '@/api/networkSignal';

/** What one attempt at a document came to, as the run needs to know it. */
export interface SeedAttempt {
  /** The settled outcome; `rate_limited` when the server asked for a pause. */
  status: SettledSeedStatus;
  /**
   * Whether the server answered (or may have answered) the request, so the run
   * counts it toward the upload pace. False for a document refused on device,
   * one never sent because the device was offline, and a 429, which the
   * server's limiter does not count.
   */
  answered: boolean;
  /** For `rate_limited`, the server's `Retry-After` in seconds when it named one. */
  retryAfterSeconds: number | null;
}

/** The 4xx range: the server's own answer that it turned the request away. */
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
/** A 4xx that says the server gave up waiting, not that it refused. */
const HTTP_REQUEST_TIMEOUT = 408;

/**
 * The vault's outcomes in the run's own vocabulary. `accepted` is renamed
 * `ingested`; the other three keep the wire word so the copy layer can say the
 * specific, actionable thing each one calls for.
 */
const VAULT_SEED_STATUS: Record<VaultUploadStatusT, VaultSeedStatus> = {
  accepted: 'ingested',
  vault_unavailable: 'vault_unavailable',
  capability_unsupported: 'capability_unsupported',
  degraded: 'degraded',
};

/**
 * The corpus's outcomes, likewise. `stored` is renamed `in_corpus` so a row can
 * name where the document actually is; the rest keep the wire word.
 *
 * Total by construction: a ninth status the server starts answering with fails
 * to compile here rather than being rendered as somebody else's outcome.
 */
const CORPUS_SEED_STATUS: Record<CorpusImportStatusT, CorpusSeedStatus> = {
  stored: 'in_corpus',
  consent_required: 'consent_required',
  tier_refused: 'tier_refused',
  format_unreadable: 'format_unreadable',
  not_text: 'not_text',
  empty_document: 'empty_document',
  document_too_long: 'document_too_long',
  unclassified: 'unclassified',
  vault_required: 'vault_required',
};

/** Whether an HTTP status is the server definitely turning the request away. */
function isDefiniteRefusal(status: number | null): boolean {
  return (
    status !== null &&
    status >= HTTP_CLIENT_ERROR_MIN &&
    status < HTTP_SERVER_ERROR_MIN &&
    status !== HTTP_REQUEST_TIMEOUT
  );
}

/**
 * Map a thrown import failure onto the run's vocabulary, bytes untouched.
 *
 * The upload is a single POST the client never retries, so a 4xx is the answer
 * to the only attempt there was: nothing was kept, and `failed` says so. Every
 * other failure -- a timeout, a dropped connection, a 5xx, a reply that could
 * not be read -- came after the document left the device, and the server may
 * already have kept it, so it settles as `unconfirmed` (#3239).
 */
function statusForError(error: unknown): SettledSeedStatus {
  if (!(error instanceof DocumentUploadError)) return 'unconfirmed';
  if (error.kind === 'too_large') return 'too_large';
  // The managed vault's request-size ceiling (#3051): refused before a byte
  // left the server, so nothing was kept -- and the same file can never fit,
  // so it is a refusal of this document, not a `failed` worth sending again.
  if (error.kind === 'managed_too_large') return 'managed_too_large';
  // A 429 is the server asking for a pause, not turning the document away
  // (#3556): nothing was kept, and the run waits it out before settling here.
  if (error.kind === 'rate_limited') return 'rate_limited';
  return isDefiniteRefusal(error.status) ? 'failed' : 'unconfirmed';
}

/** One failed request as an attempt: a 429 carries its wait and was not counted. */
function attemptForError(error: unknown): SeedAttempt {
  const status = statusForError(error);
  if (status === 'rate_limited' && error instanceof DocumentUploadError) {
    return { status, answered: false, retryAfterSeconds: error.retryAfterSeconds };
  }
  return { status, answered: true, retryAfterSeconds: null };
}

/** An attempt that never became a request. */
function decidedOnDevice(status: SettledSeedStatus): SeedAttempt {
  return { status, answered: false, retryAfterSeconds: null };
}

/**
 * The status a 202 settles on, read off the destination the server named.
 *
 * A destination whose own status field is missing is treated as `unconfirmed`
 * rather than guessed at from `stored`: the server took the request, and a body
 * that cannot say what happened to it cannot honestly be rendered as either
 * "kept" or "nothing was stored".
 */
function settledStatus(outcome: DocumentImportT): SettledSeedStatus {
  if (outcome.destination === 'vault') {
    const status = outcome.vault_status;
    return status === null || status === undefined ? 'unconfirmed' : VAULT_SEED_STATUS[status];
  }
  const status = outcome.corpus_status;
  return status === null || status === undefined ? 'unconfirmed' : CORPUS_SEED_STATUS[status];
}

/**
 * Make one attempt at a document: refuse it on device, or send it once and read
 * the answer. Never retries and never waits; the run decides what a 429 costs.
 * Never throws, for the same reason {@link importSeedDocument} does not.
 */
export async function attemptSeedDocument(
  document: PickedDocument,
  classification: JournalClassification,
): Promise<SeedAttempt> {
  if (!document.seedable) {
    return decidedOnDevice('unsupported_format');
  }
  const read = await readSeedDocument(document);
  if (read.kind !== 'read') {
    return decidedOnDevice(read.kind);
  }
  // Checked last, just before sending, so "wasn't sent" is true at the moment
  // it would have gone. Only the platform's own signal counts; with none
  // registered this is false and the request goes.
  if (isDeviceKnownOffline()) {
    return decidedOnDevice('offline');
  }
  try {
    const outcome = await corpus.importDocument({
      filename: document.name,
      contentBase64: read.contentBase64,
      classification,
      ...(document.source ? { source: document.source } : {}),
    });
    return { status: settledStatus(outcome), answered: true, retryAfterSeconds: null };
  } catch (error: unknown) {
    return attemptForError(error);
  }
}

/**
 * Send one picked document to this account's corpus at the chosen tier and
 * report what became of it, in whichever destination's words applied. One
 * attempt: a 429 settles as `rate_limited` here, and waiting it out is the
 * run's to decide.
 */
export async function importSeedDocument(
  document: PickedDocument,
  classification: JournalClassification,
): Promise<SettledSeedStatus> {
  return (await attemptSeedDocument(document, classification)).status;
}
