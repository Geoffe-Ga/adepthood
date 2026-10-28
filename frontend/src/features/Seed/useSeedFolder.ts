/**
 * Drives a folder import up to the moment it is sent: choose a folder, sort it
 * into a manifest, and hold it for review until the person starts or drops it
 * (#3555).
 *
 * **A folder is reviewed, never sent on selection.** Choosing a folder opens a
 * review showing the import's name, the selected paths, what was left out and
 * the total size. Nothing reaches the network until "Bring these in". Dropping
 * the review forgets the folder, and nothing was sent.
 *
 * **The handles stay here.** The browser's `File` handles live in this hook's
 * component state for the length of the review, and in the run's local loop
 * once sent. They never enter the run reducer, app storage or a log, and
 * unmounting the screen drops them.
 *
 * Sending reuses the run's own sequential sender, at the tier chosen on the
 * screen, so a folder document is read, encoded and sent exactly as a picked
 * one is, one at a time.
 */
import { useCallback, useMemo, useState } from 'react';

import {
  buildFolderManifest,
  selectFolderEntries,
  type FolderManifest,
  type FolderManifestEntry,
  type FolderSelection,
} from './folderManifest';
import type { PickedDocument } from './pickSeedDocuments';
import { browserFolderPickerHost, pickSeedFolder, type FolderPickerHost } from './pickSeedFolder';
import {
  folderStartBlocker,
  SEED_FOLDER_EMPTY_NOTICE,
  SEED_FOLDER_PATHLESS_NOTICE,
  SEED_FOLDER_TOO_MANY_NOTICE,
} from './seedFolderCopy';
import { isSafeSourceNamespace, normalizeSourceText } from './seedSourcePath';

/** A chosen folder awaiting the person's decision. */
export interface SeedFolderReview {
  manifest: FolderManifest<File>;
  /** The import name as typed; the folder's own name until edited. */
  namespace: string;
  includeAttachments: boolean;
  /** What "Bring these in" would send right now. */
  selection: FolderSelection<File>;
  /** Why the import cannot start yet, or null when it can. */
  blocker: string | null;
}

/** What the seeding screen reads and drives for a folder import. */
export interface SeedFolderController {
  /** Whether this platform can choose a folder at all. */
  supported: boolean;
  /** The folder under review, or null. */
  review: SeedFolderReview | null;
  /** A one-line word about a folder that could not be reviewed; null otherwise. */
  notice: string | null;
  chooseFolder: () => Promise<void>;
  setNamespace: (_namespace: string) => void;
  setIncludeAttachments: (_include: boolean) => void;
  /** Send the selection and close the review; does nothing while it is blocked. */
  start: () => Promise<void>;
  /** Close the review and forget the folder; nothing is sent. */
  dismiss: () => void;
}

/** The parts of a review the person sets; the rest is derived from them. */
interface PendingFolder {
  manifest: FolderManifest<File>;
  namespace: string;
  includeAttachments: boolean;
}

/**
 * One folder entry as a picked document. The `uri` is empty because a folder
 * exists only on the web, where the read step uses `browserFile` instead.
 */
function toPickedDocument(entry: FolderManifestEntry<File>, namespace: string): PickedDocument {
  return {
    name: entry.name,
    uri: '',
    browserFile: entry.file,
    size: entry.size,
    seedable: true,
    source: { namespace, relativePath: entry.relativePath },
  };
}

/** Derive the selection and what blocks it from the person's choices. */
function toReview(pending: PendingFolder): SeedFolderReview {
  const selection = selectFolderEntries(pending.manifest, pending.includeAttachments);
  const blocker = folderStartBlocker({
    count: selection.entries.length,
    withinBounds: selection.withinBounds,
    namespaceValid: isSafeSourceNamespace(pending.namespace),
  });
  return { ...pending, selection, blocker };
}

/** What choosing a folder leaves behind: a folder to review, or a notice. */
type ChosenFolder = { pending: PendingFolder } | { notice: string | null };

/**
 * Whether the browser handed over files with no place in a folder at all: it
 * claims folder support but returns loose files, as iOS Safari does.
 */
function isPathless(files: readonly File[]): boolean {
  return files.length > 0 && files.every((picked) => picked.webkitRelativePath === '');
}

/** Open the folder dialog and sort what came back, reading no file. */
async function chooseAndSort(picker: FolderPickerHost<File> | null): Promise<ChosenFolder> {
  const picked = await pickSeedFolder(picker);
  if (picked.kind !== 'picked') return { notice: null };
  if (isPathless(picked.files)) return { notice: SEED_FOLDER_PATHLESS_NOTICE };
  const built = buildFolderManifest(picked.files);
  if (built.kind === 'empty') return { notice: SEED_FOLDER_EMPTY_NOTICE };
  if (built.kind === 'too_many') return { notice: SEED_FOLDER_TOO_MANY_NOTICE };
  const { manifest } = built;
  return { pending: { manifest, namespace: manifest.rootName, includeAttachments: false } };
}

/**
 * The folder-import controller. `host` defaults to the browser's folder
 * picker; pass null for a platform with none.
 */
export function useSeedFolder(
  send: (_documents: readonly PickedDocument[]) => Promise<void>,
  host?: FolderPickerHost<File> | null,
): SeedFolderController {
  const [picker] = useState(() => (host === undefined ? browserFolderPickerHost() : host));
  const [pending, setPending] = useState<PendingFolder | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const chooseFolder = useCallback(async () => {
    const chosen = await chooseAndSort(picker);
    if ('pending' in chosen) {
      setNotice(null);
      setPending(chosen.pending);
    } else {
      setNotice(chosen.notice);
    }
  }, [picker]);

  const setNamespace = useCallback((namespace: string) => {
    setPending((current) => (current === null ? null : { ...current, namespace }));
  }, []);

  const setIncludeAttachments = useCallback((includeAttachments: boolean) => {
    setPending((current) => (current === null ? null : { ...current, includeAttachments }));
  }, []);

  const dismiss = useCallback(() => setPending(null), []);

  const review = useMemo(() => (pending === null ? null : toReview(pending)), [pending]);

  const start = useCallback(async () => {
    if (review === null || review.blocker !== null) return;
    const namespace = normalizeSourceText(review.namespace);
    const documents = review.selection.entries.map((entry) => toPickedDocument(entry, namespace));
    setPending(null);
    await send(documents);
  }, [review, send]);

  return {
    supported: picker !== null,
    review,
    notice,
    chooseFolder,
    setNamespace,
    setIncludeAttachments,
    start,
    dismiss,
  };
}
