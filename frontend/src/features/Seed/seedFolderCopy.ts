/**
 * What a folder import says out loud: the review before anything is sent, and
 * the notices for a folder that cannot be reviewed at all (#3555).
 *
 * The review counts rather than judges. Notes are selected because they are
 * the writing; attachments are offered, not pressed; files left out are
 * counted by reason and never named, so a review shown over someone's shoulder
 * does not read their folder back to the room.
 */
import {
  MAX_FOLDER_ENUMERATED_FILES,
  MAX_FOLDER_SELECTED_BYTES,
  type FolderSkipReason,
} from './folderManifest';
import { MAX_SEED_DOCUMENT_LABEL } from './readSeedDocument';

/** The button beside "choose files", shown only where a folder can be chosen. */
export const SEED_CHOOSE_FOLDER_LABEL = 'Choose a folder';

export const SEED_FOLDER_EMPTY_NOTICE = "That folder is empty, so there's nothing to bring in.";

export const SEED_FOLDER_TOO_MANY_NOTICE =
  `That folder holds more than ${MAX_FOLDER_ENUMERATED_FILES.toLocaleString()} files. ` +
  'Choose a smaller folder, or one inside it.';

export const SEED_FOLDER_REVIEW_TITLE = 'Before anything is sent';

export const SEED_FOLDER_NAMESPACE_LABEL = 'Import name';

export const SEED_FOLDER_NAMESPACE_HINT =
  'Bring the same folder in again under this name and its notes are updated, not copied.';

export const SEED_FOLDER_START_LABEL = 'Bring these in';

export const SEED_FOLDER_DISMISS_LABEL = 'Not now';

export const SEED_FOLDER_NOTHING_SELECTED = 'Nothing is selected to bring in yet.';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export const SEED_FOLDER_OVER_BYTES =
  `That's more than ${MAX_FOLDER_SELECTED_BYTES / BYTES_PER_MB} MB at once. ` +
  'Leave the attachments out, or choose a folder inside this one.';

export const SEED_FOLDER_NAMESPACE_INVALID =
  'Give this import a name, without spaces at either end.';

/** `1 note` / `2 notes`. */
function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The selected-notes line. */
export function folderNotesLine(count: number): string {
  return count === 0 ? 'No notes in this folder' : `${counted(count, 'note', 'notes')} selected`;
}

/** The label of the one switch that adds every attachment. */
export function folderAttachmentsLabel(count: number): string {
  return `Also bring in ${counted(count, 'attachment', 'attachments')} (images, PDFs and other documents)`;
}

/** Each skip reason, as a phrase following its count. */
const SKIP_PHRASES: Record<FolderSkipReason, string> = {
  configuration: 'app settings',
  hidden: 'hidden',
  unsupported: 'of a kind nothing here reads',
  unsafe_path: 'with a name that can’t be sent',
  too_large: `larger than ${MAX_SEED_DOCUMENT_LABEL}`,
  collision: 'spelled two ways that would overwrite each other',
};

/** In the order the manifest decides them. */
const SKIP_ORDER: readonly FolderSkipReason[] = [
  'configuration',
  'hidden',
  'unsupported',
  'unsafe_path',
  'too_large',
  'collision',
];

/** Every reason a file was left out, with its count; null when none were. */
export function folderSkippedLine(skipped: Record<FolderSkipReason, number>): string | null {
  const parts = SKIP_ORDER.filter((reason) => skipped[reason] > 0).map(
    (reason) => `${skipped[reason]} ${SKIP_PHRASES[reason]}`,
  );
  if (parts.length === 0) return null;
  const total = SKIP_ORDER.reduce((sum, reason) => sum + skipped[reason], 0);
  return `Left out ${counted(total, 'file', 'files')}: ${parts.join(', ')}.`;
}

/** A selection's size: whole KB below a megabyte, one decimal of MB above. */
export function folderBytesLabel(bytes: number): string {
  if (bytes < BYTES_PER_MB) return `${Math.round(bytes / BYTES_PER_KB)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/** The selection's total size, as the review states it. */
export function folderSelectedSizeLine(bytes: number): string {
  return `${folderBytesLabel(bytes)} in all`;
}

/** The line under a truncated path list; null when every path is shown. */
export function folderMoreLine(hidden: number): string | null {
  return hidden > 0 ? `…and ${hidden} more` : null;
}

/** What keeps the import from starting, first thing first; null when nothing does. */
export function folderStartBlocker({
  count,
  withinBounds,
  namespaceValid,
}: {
  count: number;
  withinBounds: boolean;
  namespaceValid: boolean;
}): string | null {
  if (count === 0) return SEED_FOLDER_NOTHING_SELECTED;
  if (!withinBounds) return SEED_FOLDER_OVER_BYTES;
  if (!namespaceValid) return SEED_FOLDER_NAMESPACE_INVALID;
  return null;
}
