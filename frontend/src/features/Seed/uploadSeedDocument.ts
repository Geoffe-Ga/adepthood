/**
 * One document's whole journey: refuse it on device if the vault could not read
 * it or the endpoint would not take it, otherwise encode it and hand it over,
 * and answer with the single settled status the run renders.
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
import type { SettledSeedStatus } from './seedRun';

import { DocumentUploadError, journal, type JournalClassification } from '@/api';

/** Map a thrown upload failure onto the run's vocabulary, bytes untouched. */
function statusForError(error: unknown): SettledSeedStatus {
  if (error instanceof DocumentUploadError && error.kind === 'too_large') {
    return 'too_large';
  }
  return 'failed';
}

/**
 * Send one picked document to the vault at the chosen tier and report what
 * became of it. `accepted` is renamed `ingested` for the run's own vocabulary;
 * every other vault outcome keeps the wire word so the copy layer can say the
 * specific, actionable thing each one calls for.
 */
export async function uploadSeedDocument(
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
    const outcome = await journal.uploadDocument({
      filename: document.name,
      contentBase64: read.contentBase64,
      classification,
    });
    return outcome.status === 'accepted' ? 'ingested' : outcome.status;
  } catch (error: unknown) {
    return statusForError(error);
  }
}
