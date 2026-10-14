/**
 * Best-effort cleanup of the transient on-device files a capture page owns:
 * the picker/camera cache copy it came from and the downscaled manipulator
 * output built for transcription. Deletion is idempotent and failures are
 * swallowed — the OS reclaims its cache eventually, and cleanup must never
 * block or break the writing flow.
 *
 * PRIVACY: warnings emit only a fixed code, without filenames, device paths or contents.
 */
import { File } from 'expo-file-system';

import { reportDiagnostic } from '@/observability/diagnostics';

/** The two transient device files a capture page owns. */
export interface CapturePageFiles {
  /** The original picker/camera cache copy the page was prepared from. */
  sourceUri: string;
  /** The downscaled manipulator-output file sent for transcription. */
  uri: string;
}

/** Delete one transient file, idempotently; a failure only warns, metadata-only. */
function deleteQuietly(uri: string): void {
  try {
    const file = new File(uri);
    // Guarded rather than deleted outright: ``delete()`` throws on a file that
    // is already gone, where the retired ``deleteAsync(uri, { idempotent: true })``
    // resolved quietly. Cleanup runs over files an earlier pass may already have
    // released, so absence is a success, not something to warn about.
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Deliberately swallowed: cleanup is best-effort, and the raised error can
    // embed paths and private filenames, so only a fixed code is surfaced.
    reportDiagnostic('capture_cleanup_failed');
  }
}

/**
 * Release both of one page's transient device files. Each deletion failure is
 * contained (warned, never thrown), so the other file is always attempted and
 * the returned promise never rejects.
 */
export async function releasePageFiles(page: CapturePageFiles): Promise<void> {
  deleteQuietly(page.sourceUri);
  deleteQuietly(page.uri);
}

/**
 * Release a loose set of transient device files by uri — used to reclaim the
 * partial artifacts of a batch that failed before any page was stored (the
 * source copies and any already-downscaled outputs). Failures are swallowed
 * and every uri is attempted; an empty set touches nothing.
 */
export async function releaseUris(uris: readonly string[]): Promise<void> {
  uris.forEach((uri) => {
    deleteQuietly(uri);
  });
}

/**
 * Release the transient device files of every page in a batch. Individual
 * failures never stop the remaining pages; an empty batch resolves without
 * touching the filesystem.
 */
export async function releaseAllPageFiles(pages: readonly CapturePageFiles[]): Promise<void> {
  await Promise.all(pages.map((page) => releasePageFiles(page)));
}
