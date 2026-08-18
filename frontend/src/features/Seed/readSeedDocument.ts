/**
 * Reads one picked document off the device and encodes it for the upload
 * request, refusing anything past the endpoint's cap before a byte is loaded.
 *
 * The cap is checked twice, cheapest first, mirroring the backend's own guard:
 * against the size the picker reported (or the file's own, when it reported
 * none), and again against the decoded length of what was actually read, so a
 * document whose reported size understated it is still caught on device rather
 * than becoming a doomed 13 MB request.
 *
 * PRIVACY: the returned payload IS the document. It is never logged here, lives
 * in the run's state only for as long as its upload is in flight, and no read
 * failure message carries any of it.
 */
import { File } from 'expo-file-system';

import type { PickedDocument } from './pickSeedDocuments';

import { decodedBase64ByteLength } from '@/utils/base64Size';

/**
 * The endpoint's decoded-bytes ceiling for one document — the same value the
 * backend enforces (``MAX_UPLOAD_BYTES`` in ``schemas/journal_upload.py``), kept
 * honest by the drift test beside this module rather than by a comment.
 */
export const MAX_SEED_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** How the cap is said out loud, so every surface names the same number. */
export const MAX_SEED_DOCUMENT_LABEL = '10 MB';

/**
 * The outcome of reading one document, discriminated on `kind`:
 *
 *  - `read`       — the document, base64-encoded, ready for the request body.
 *  - `too_large`  — past the cap; nothing was sent and nothing will be.
 *  - `unreadable` — the file could not be opened, or held nothing.
 */
export type SeedReadResult =
  { kind: 'read'; contentBase64: string } | { kind: 'too_large' } | { kind: 'unreadable' };

/** The document's size in bytes: the picker's figure, or the file's own. */
function knownByteLength(document: PickedDocument, file: File): number {
  return document.size ?? file.size;
}

/**
 * Read and encode one document, or say why it cannot be sent. Never throws: a
 * missing or unopenable file settles as `unreadable` so one bad file in a
 * selection cannot abandon the rest of the run.
 */
export async function readSeedDocument(document: PickedDocument): Promise<SeedReadResult> {
  const file = new File(document.uri);
  try {
    if (knownByteLength(document, file) > MAX_SEED_DOCUMENT_BYTES) {
      return { kind: 'too_large' };
    }
    const contentBase64 = await file.base64();
    if (contentBase64 === '') {
      return { kind: 'unreadable' };
    }
    if (decodedBase64ByteLength(contentBase64) > MAX_SEED_DOCUMENT_BYTES) {
      return { kind: 'too_large' };
    }
    return { kind: 'read', contentBase64 };
  } catch {
    // Swallowed deliberately: the raised error can embed the full device path,
    // and the run only needs to know this one document did not open.
    return { kind: 'unreadable' };
  }
}
