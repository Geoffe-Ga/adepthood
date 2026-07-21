/**
 * Best-effort cleanup of the transient on-device files a capture page owns:
 * the picker/camera cache copy it came from and the downscaled manipulator
 * output built for transcription. Deletion is idempotent and failures are
 * swallowed — the OS reclaims its cache eventually, and cleanup must never
 * block or break the writing flow.
 *
 * PRIVACY: warnings emitted here carry only a cache-relative filename — never
 * a full device path, and never any image contents.
 */
import * as FileSystem from 'expo-file-system';

/** The two transient device files a capture page owns. */
export interface CapturePageFiles {
  /** The original picker/camera cache copy the page was prepared from. */
  sourceUri: string;
  /** The downscaled manipulator-output file sent for transcription. */
  uri: string;
}

/**
 * Reduce a file uri to its cache-relative name for logging: the path under
 * the cache directory when it lives there, otherwise just the basename.
 * Never the full uri — device paths (and anything beyond metadata) stay out
 * of logs.
 */
function cacheRelativeName(uri: string): string {
  const cacheRoot = FileSystem.cacheDirectory;
  if (cacheRoot && uri.startsWith(cacheRoot)) {
    return uri.slice(cacheRoot.length);
  }
  return uri.split('/').at(-1) ?? uri;
}

/** Delete one transient file, idempotently; a failure only warns, metadata-only. */
async function deleteQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Deliberately swallowed: cleanup is best-effort, and the raised error can
    // embed the full path — so only the cache-relative name is surfaced.
    console.warn(`Journal capture: could not delete transient file ${cacheRelativeName(uri)}`);
  }
}

/**
 * Release both of one page's transient device files. Each deletion failure is
 * contained (warned, never thrown), so the other file is always attempted and
 * the returned promise never rejects.
 */
export async function releasePageFiles(page: CapturePageFiles): Promise<void> {
  await deleteQuietly(page.sourceUri);
  await deleteQuietly(page.uri);
}

/**
 * Release a loose set of transient device files by uri — used to reclaim the
 * partial artifacts of a batch that failed before any page was stored (the
 * source copies and any already-downscaled outputs). Failures are swallowed
 * and every uri is attempted; an empty set touches nothing.
 */
export async function releaseUris(uris: readonly string[]): Promise<void> {
  await Promise.all(uris.map((uri) => deleteQuietly(uri)));
}

/**
 * Release the transient device files of every page in a batch. Individual
 * failures never stop the remaining pages; an empty batch resolves without
 * touching the filesystem.
 */
export async function releaseAllPageFiles(pages: readonly CapturePageFiles[]): Promise<void> {
  await Promise.all(pages.map((page) => releasePageFiles(page)));
}
