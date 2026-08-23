/**
 * One document's whole journey: refuse it on device if it cannot be read or the
 * endpoint would not take it, otherwise encode it and hand it over, and answer
 * with the single settled status the run renders.
 *
 * **One route, and the destination is the server's answer.** `POST
 * /corpus/import` routes per account — the vault for somebody who has connected
 * one, their own ontologized corpus for somebody who has not — so this module
 * asks once and reads which of the two answered. It never checks for a vault
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
};

/** Map a thrown import failure onto the run's vocabulary, bytes untouched. */
function statusForError(error: unknown): SettledSeedStatus {
  if (error instanceof DocumentUploadError && error.kind === 'too_large') {
    return 'too_large';
  }
  return 'failed';
}

/**
 * The status a 202 settles on, read off the destination the server named.
 *
 * A destination whose own status field is missing is treated as no outcome at
 * all — `failed`, the same as a request that never produced one — rather than
 * guessed at from `stored`. A body that cannot say what happened is not a body
 * to render a sentence from.
 */
function settledStatus(outcome: DocumentImportT): SettledSeedStatus {
  if (outcome.destination === 'vault') {
    const status = outcome.vault_status;
    return status === null || status === undefined ? 'failed' : VAULT_SEED_STATUS[status];
  }
  const status = outcome.corpus_status;
  return status === null || status === undefined ? 'failed' : CORPUS_SEED_STATUS[status];
}

/**
 * Send one picked document to this account's corpus at the chosen tier and
 * report what became of it, in whichever destination's words applied.
 */
export async function importSeedDocument(
  document: PickedDocument,
  classification: JournalClassification,
): Promise<SettledSeedStatus> {
  if (!document.seedable) {
    return 'unsupported_format';
  }
  const read = await readSeedDocument(document);
  if (read.kind !== 'read') {
    return read.kind;
  }
  try {
    return settledStatus(
      await corpus.importDocument({
        filename: document.name,
        contentBase64: read.contentBase64,
        classification,
      }),
    );
  } catch (error: unknown) {
    return statusForError(error);
  }
}
