/**
 * Turns a chosen folder's file list into an import manifest: which documents
 * could go, under which folder-relative path, and why the rest cannot (#3555).
 *
 * **Built from metadata alone.** Each file contributes its path, name and size.
 * Nothing here opens a file. The bytes are read later, one document at a time,
 * by the run's existing read step, and only for documents the person kept in
 * the selection. A folder's `.obsidian` settings are counted and never read.
 *
 * **Nothing is merged or flattened.** Each document keeps its path under the
 * chosen folder, so `Work/Index.md` and `Home/Index.md` stay two documents.
 * Two paths that are one path once normalized (an NFC and an NFD spelling of
 * the same name) are both held back as a collision rather than one silently
 * winning, because either upload would overwrite the other.
 *
 * Every file the folder held is counted somewhere: as a note, as an
 * attachment, or under one skip reason. Notes start selected; attachments are
 * one optional group (see `seedDocumentTypes`).
 */
import { isSafeFilename } from './pickSeedDocuments';
import { MAX_SEED_DOCUMENT_BYTES } from './readSeedDocument';
import { seedDocumentKind, type SeedDocumentKind } from './seedDocumentTypes';
import {
  isSafeSourceRelativePath,
  normalizeSourceText,
  SOURCE_PATH_SEPARATOR,
} from './seedSourcePath';

/** Most files a chosen folder may hold before the import is refused outright. */
export const MAX_FOLDER_ENUMERATED_FILES = 10_000;

/** Most bytes one folder import may select, summed across its documents (250 MiB). */
export const MAX_FOLDER_SELECTED_BYTES = 250 * 1024 * 1024;

/** The longest filename the server accepts, in code points. */
const MAX_FILENAME_LENGTH = 255;

/**
 * Folders that hold an application's state rather than writing. Matched on any
 * path component, case-insensitively, so a note stored inside one is skipped
 * with the rest.
 */
const CONFIGURATION_FOLDERS: readonly string[] = ['.obsidian', '.git', '.trash', '__macosx'];

/** A leading dot hides a file or folder; a hidden one is not part of the import. */
const HIDDEN_PREFIX = '.';

/**
 * The metadata a folder picker hands over for each file. A browser `File`
 * satisfies it; the manifest never asks it for content.
 */
export interface FolderFileLike {
  readonly name: string;
  readonly size: number;
  /** The path from the chosen folder's parent: `My Vault/Work/Index.md`. */
  readonly webkitRelativePath: string;
}

/** Why a file in the folder is not offered for import. */
export type FolderSkipReason =
  'configuration' | 'hidden' | 'unsupported' | 'unsafe_path' | 'too_large' | 'collision';

/** One document the import can send, with the handle its bytes are read from later. */
export interface FolderManifestEntry<F> {
  /** NFC path under the chosen folder, `/`-separated: `Work/Index.md`. */
  relativePath: string;
  /** The last component of `relativePath`, sent as the upload's filename. */
  name: string;
  size: number;
  kind: SeedDocumentKind;
  file: F;
}

/** Everything a chosen folder holds, sorted into what can go and what cannot. */
export interface FolderManifest<F> {
  /** The chosen folder's own name (NFC): the import namespace by default. */
  rootName: string;
  /** Notes, in path order; selected by default. */
  notes: FolderManifestEntry<F>[];
  /** Supported attachments, in path order; selected only on request. */
  attachments: FolderManifestEntry<F>[];
  /** How many files were held back, by reason. */
  skipped: Record<FolderSkipReason, number>;
  /** How many files the folder held in all. */
  enumerated: number;
}

/**
 * The outcome of building a manifest, discriminated on `kind`:
 *
 *  - `empty`    — the folder held no files at all.
 *  - `too_many` — past {@link MAX_FOLDER_ENUMERATED_FILES}; nothing was sorted.
 *  - `manifest` — the sorted folder.
 */
export type FolderManifestResult<F> =
  | { kind: 'empty' }
  | { kind: 'too_many'; enumerated: number }
  | { kind: 'manifest'; manifest: FolderManifest<F> };

/** What a person has chosen to send from a manifest. */
export interface FolderSelection<F> {
  entries: FolderManifestEntry<F>[];
  bytes: number;
  /** False once `bytes` passes {@link MAX_FOLDER_SELECTED_BYTES}. */
  withinBounds: boolean;
}

/** One file, sorted: an entry to offer, or the reason it is held back. */
type Sorted<F> = FolderManifestEntry<F> | FolderSkipReason;

function emptySkipCounts(): Record<FolderSkipReason, number> {
  return {
    configuration: 0,
    hidden: 0,
    unsupported: 0,
    unsafe_path: 0,
    too_large: 0,
    collision: 0,
  };
}

/** Order by path, code unit by code unit, so no locale can reorder a manifest. */
function byPath<F>(left: FolderManifestEntry<F>, right: FolderManifestEntry<F>): number {
  if (left.relativePath === right.relativePath) return 0;
  return left.relativePath < right.relativePath ? -1 : 1;
}

/**
 * The chosen folder's name: the first path component the files share. A
 * browser picker roots every file in one folder; should a list ever mix roots,
 * the most common one wins (ties to the first in code-unit order) and the
 * files outside it are held back as unsafe rather than imported under it.
 */
function rootOf(files: readonly FolderFileLike[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const separator = file.webkitRelativePath.indexOf(SOURCE_PATH_SEPARATOR);
    if (separator > 0) {
      const root = file.webkitRelativePath.slice(0, separator);
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [root, count] of counts) {
    if (count > bestCount || (count === bestCount && root < best)) {
      best = root;
      bestCount = count;
    }
  }
  return best;
}

/** Why a path's folders and name keep it out, judged before its type. */
function pathExclusion(components: readonly string[]): FolderSkipReason | null {
  if (components.some((part) => CONFIGURATION_FOLDERS.includes(part.toLowerCase()))) {
    return 'configuration';
  }
  if (components.some((part) => part.startsWith(HIDDEN_PREFIX))) return 'hidden';
  return null;
}

/** Whether the server would accept this path and its last component as a filename. */
function isAcceptablePath(relativePath: string, name: string): boolean {
  return (
    isSafeSourceRelativePath(relativePath) &&
    isSafeFilename(name) &&
    Array.from(name).length <= MAX_FILENAME_LENGTH
  );
}

/** Sort one file into an entry or a skip reason, from its metadata alone. */
function sortFile<F extends FolderFileLike>(file: F, root: string): Sorted<F> {
  const prefix = `${root}${SOURCE_PATH_SEPARATOR}`;
  if (root === '' || !file.webkitRelativePath.startsWith(prefix)) return 'unsafe_path';
  const relativePath = normalizeSourceText(file.webkitRelativePath.slice(prefix.length));
  const components = relativePath.split(SOURCE_PATH_SEPARATOR);
  const name = components[components.length - 1] ?? '';
  const excluded = pathExclusion(components);
  if (excluded !== null) return excluded;
  const kind = seedDocumentKind(name);
  if (kind === null) return 'unsupported';
  if (!isAcceptablePath(relativePath, name)) return 'unsafe_path';
  if (file.size > MAX_SEED_DOCUMENT_BYTES) return 'too_large';
  return { relativePath, name, size: file.size, kind, file };
}

/** Split entries whose normalized path is unique from those that share one. */
function withoutCollisions<F>(entries: readonly FolderManifestEntry<F>[]): {
  unique: FolderManifestEntry<F>[];
  collided: number;
} {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.relativePath, (counts.get(entry.relativePath) ?? 0) + 1);
  }
  const unique = entries.filter((entry) => counts.get(entry.relativePath) === 1);
  return { unique, collided: entries.length - unique.length };
}

/** Sort a non-empty, in-bounds file list into a manifest. */
function sortFolder<F extends FolderFileLike>(files: readonly F[]): FolderManifest<F> {
  const root = rootOf(files);
  const skipped = emptySkipCounts();
  const entries: FolderManifestEntry<F>[] = [];
  for (const file of files) {
    const sorted = sortFile(file, root);
    if (typeof sorted === 'string') skipped[sorted] += 1;
    else entries.push(sorted);
  }
  const { unique, collided } = withoutCollisions(entries);
  skipped.collision = collided;
  unique.sort(byPath);
  return {
    rootName: normalizeSourceText(root),
    notes: unique.filter((entry) => entry.kind === 'note'),
    attachments: unique.filter((entry) => entry.kind === 'attachment'),
    skipped,
    enumerated: files.length,
  };
}

/**
 * Sort a chosen folder's files into a manifest, reading no file's content.
 * The bound on the number of files is checked before any file is looked at.
 */
export function buildFolderManifest<F extends FolderFileLike>(
  files: readonly F[],
): FolderManifestResult<F> {
  if (files.length === 0) return { kind: 'empty' };
  if (files.length > MAX_FOLDER_ENUMERATED_FILES) {
    return { kind: 'too_many', enumerated: files.length };
  }
  return { kind: 'manifest', manifest: sortFolder(files) };
}

/**
 * The documents a person would send: every note, plus the attachments when
 * they asked for them, in path order and with their summed size.
 */
export function selectFolderEntries<F>(
  manifest: FolderManifest<F>,
  includeAttachments: boolean,
): FolderSelection<F> {
  const entries = includeAttachments
    ? [...manifest.notes, ...manifest.attachments].sort(byPath)
    : [...manifest.notes];
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  return { entries, bytes, withinBounds: bytes <= MAX_FOLDER_SELECTED_BYTES };
}
