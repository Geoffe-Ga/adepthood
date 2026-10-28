/**
 * The one list of document types a seed can carry: a folder import and the
 * individual-file picker both read it, so a type is either submittable both
 * ways or neither (#3553, owner decision R1-5).
 *
 * The list is Creek-Vault's, not ours. `POST /v1/uploads` chooses an ingestor
 * from the filename's extension through one routing table, falls back to a
 * plain-text reader for a few more, and unpacks a `.zip` export. The test beside
 * this module restates those sets with their Creek source locations and fails
 * when this list stops matching them.
 *
 * The list splits into two groups. **Notes** are the writing itself (Markdown
 * and plain text), and a folder import selects them by default. **Attachments**
 * are everything else Creek reads (documents, spreadsheets, decks, images,
 * logs and export archives). A person opts into them as a group, because a
 * vault's images and PDFs are often someone else's material.
 */

/** Markdown and plain text: the writing a folder import selects by default. */
export const SEED_NOTE_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.text'];

/**
 * Everything else Creek ingests. `.log` sits here rather than with the notes:
 * Creek reads it as text, but a vault's log files are rarely writing someone
 * means to keep. `.zip` is here because a Discord, ChatGPT or Substack export
 * arrives as one archive.
 */
export const SEED_ATTACHMENT_EXTENSIONS: readonly string[] = [
  '.log',
  '.pdf',
  '.docx',
  '.rtf',
  '.html',
  '.htm',
  '.csv',
  '.xlsx',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.webp',
  '.zip',
];

/** Every extension the vault has an ingestor for. */
export const SEED_DOCUMENT_EXTENSIONS: readonly string[] = [
  ...SEED_NOTE_EXTENSIONS,
  ...SEED_ATTACHMENT_EXTENSIONS,
];

/** Which group a supported document belongs to. */
export type SeedDocumentKind = 'note' | 'attachment';

/** The extension's separator; the extension is read from the last one. */
const EXTENSION_SEPARATOR = '.';

/** The lowercased extension of `name`, dot included, or null when it has none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(EXTENSION_SEPARATOR);
  return dot < 0 ? null : name.slice(dot).toLowerCase();
}

/** Whether `name` is a note, an attachment, or (null) a type the vault cannot read. */
export function seedDocumentKind(name: string): SeedDocumentKind | null {
  const extension = extensionOf(name);
  if (extension === null) return null;
  if (SEED_NOTE_EXTENSIONS.includes(extension)) return 'note';
  if (SEED_ATTACHMENT_EXTENSIONS.includes(extension)) return 'attachment';
  return null;
}
