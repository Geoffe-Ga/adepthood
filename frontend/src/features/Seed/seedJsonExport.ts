/**
 * A loose conversation export: a `.json` sent on its own rather than inside the
 * `.zip` it arrived in (#3797).
 *
 * A ChatGPT `conversations.json`, a Claude export and a Discord `messages.json`
 * are each one JSON file, and a person who has already unpacked an export can
 * send that file as it is. **What a `.json` holds is the server's question,
 * never the device's**: the file is sent, and whether it is an export is
 * answered there. Nothing here opens one; the name is all that is read, and
 * only to choose the words of a row.
 *
 * Three outcomes read differently for a `.json` than for any other file,
 * because each has a remedy only an export has: the `.zip` it came in.
 *
 * The lines live here rather than in `seedCopy` so that this module is the
 * whole of what a `.json` adds, and every other file's words stay untouched.
 */
import { MANAGED_SEED_DOCUMENT_LABEL, MAX_SEED_DOCUMENT_LABEL } from './readSeedDocument';
import { SEED_STATUS_LINES } from './seedCopy';
import type { SeedItem, SeedItemStatus } from './seedRun';

/** The extension a loose conversation export carries. */
const JSON_EXPORT_EXTENSION = '.json';

/** Whether `name` (a filename or a folder path) ends in `.json`, in any letter case. */
export function isJsonExportName(name: string): boolean {
  return name.toLowerCase().endsWith(JSON_EXPORT_EXTENSION);
}

/**
 * Shown above the pickers, beside the invitation's "notes, exports, documents":
 * which exports come in as a single file, and that the archive still does.
 */
export const SEED_JSON_EXPORT_NOTE =
  'A ChatGPT, Claude or Discord conversation export can come in as its .json file, or as ' +
  'the .zip it arrived in.';

/**
 * The outcomes a `.json` row words differently, keyed like
 * {@link SEED_STATUS_LINES}. Every other outcome reads as it does for any file.
 */
export const SEED_JSON_STATUS_LINES: Readonly<Partial<Record<SeedItemStatus, string>>> = {
  // Sent, and turned away for what it holds: a `package.json`, a plugin's
  // data, an export with no conversations in it. Worded to stay true of a
  // server that reads no loose export at all yet, which answers the same way
  // for every `.json`; the `.zip` goes over in both cases.
  unsupported_source:
    'Skipped · this .json is not a conversation export your Corpus reads, so nothing was ' +
    "stored. If it came from ChatGPT, Claude or Discord, send the export's .zip instead.",
  // Decided on device from its size, before it was read. An export this large
  // is usually far smaller as the archive it arrived in.
  too_large:
    `Skipped · larger than ${MAX_SEED_DOCUMENT_LABEL}, which is as much as one document can ` +
    "carry, so it was never sent. If it is a conversation export, send the export's .zip " +
    'instead.',
  // The managed request ceiling (#3051), checked on the server before the
  // document left it. Splitting a `.json` would break it, so the smaller
  // archive is the remedy offered.
  managed_too_large:
    'Too large to go over as one file, so nothing was stored. Your Corpus takes files up to ' +
    `about ${MANAGED_SEED_DOCUMENT_LABEL}; if this is a conversation export, the export's ` +
    '.zip is smaller and may fit.',
};

/**
 * The line beneath one document's name: the `.json` wording where there is
 * one, and otherwise the line every file with that outcome gets.
 */
export function seedStatusLine(item: Pick<SeedItem, 'name' | 'status'>): string {
  const jsonLine = isJsonExportName(item.name) ? SEED_JSON_STATUS_LINES[item.status] : undefined;
  return jsonLine ?? SEED_STATUS_LINES[item.status];
}
