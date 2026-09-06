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
import { File as ExpoFile } from 'expo-file-system';
import { Platform } from 'react-native';

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

/** A browser read must settle while the screen is still actionable. */
export const SEED_DOCUMENT_READ_TIMEOUT_MS = 10_000;

/** Keep each `fromCharCode` call comfortably below browser argument limits. */
const BASE64_CHUNK_BYTES = 32 * 1024;

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
function knownByteLength(document: PickedDocument, file: { size: number }): number {
  return document.size ?? file.size;
}

/** Encode bytes without relying on Node's Buffer, which does not exist on web. */
function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

/** Bound a browser File read so a broken handle cannot strand the whole run. */
function withReadTimeout<T>(read: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Browser document read timed out'));
    }, SEED_DOCUMENT_READ_TIMEOUT_MS);
    void read.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/** Read the real browser File retained from the picker, not its opaque blob URI. */
async function readBrowserDocument(document: PickedDocument, file: File): Promise<SeedReadResult> {
  if (knownByteLength(document, file) > MAX_SEED_DOCUMENT_BYTES) {
    return { kind: 'too_large' };
  }
  const buffer = await withReadTimeout(file.arrayBuffer());
  if (buffer.byteLength === 0) {
    return { kind: 'unreadable' };
  }
  if (buffer.byteLength > MAX_SEED_DOCUMENT_BYTES) {
    return { kind: 'too_large' };
  }
  return { kind: 'read', contentBase64: encodeBase64(buffer) };
}

/**
 * Read and encode one document, or say why it cannot be sent. Never throws: a
 * missing or unopenable file settles as `unreadable` so one bad file in a
 * selection cannot abandon the rest of the run.
 */
export async function readSeedDocument(document: PickedDocument): Promise<SeedReadResult> {
  try {
    if (Platform.OS === 'web') {
      // Expo's web picker creates an opaque blob URI and supplies the File that
      // owns it. `expo-file-system` is a native path API and cannot reopen that
      // URI reliably; a missing File is therefore a contained read failure.
      return document.browserFile
        ? await readBrowserDocument(document, document.browserFile)
        : { kind: 'unreadable' };
    }
    const file = new ExpoFile(document.uri);
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
