/**
 * Wraps `expo-document-picker` for seeding the corpus: open the system file
 * browser for a multi-selection and hand back each chosen document's name, uri,
 * and known size — or a discriminated reason none were usable.
 *
 * The picker itself reads nothing. Bytes are loaded once, later, by the run's
 * read step, so a pick of forty files costs one dialog and no memory.
 *
 * The system dialog is deliberately opened unfiltered. A MIME filter looks
 * tidier but lies on Android, where `text/markdown` and export archives are
 * routinely unknown types and would simply be greyed out; the extension check
 * below is the honest filter, and it keeps a document the vault cannot read
 * *visible* in the run with its own explanation rather than silently absent.
 */
import * as DocumentPicker from 'expo-document-picker';

/**
 * The extensions the vault has an ingestor for. `.zip` is here because a
 * Discord / ChatGPT / Substack export arrives as one archive, which is the
 * shape most real seeding takes.
 */
export const SEED_DOCUMENT_EXTENSIONS: readonly string[] = [
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.docx',
  '.rtf',
  '.html',
  '.htm',
  '.csv',
  '.xlsx',
  '.pptx',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.zip',
];

/** The two characters that would turn a filename into a path; the backend refuses both. */
const PATH_SEPARATORS = ['/', '\\'];

/** A run of dots is how a name climbs out of the collection it was meant to sit in. */
const CONSECUTIVE_DOTS = '..';

/**
 * Whether the backend would accept this as one plain, inert filename. Mirrors
 * the server's own rule (no separator, no dot run, no leading dot, no
 * surrounding whitespace) so a name it would refuse is named on device instead
 * of spending a round trip to earn a 422.
 */
function isSafeFilename(name: string): boolean {
  if (name.includes(CONSECUTIVE_DOTS) || name.startsWith('.')) {
    return false;
  }
  if (PATH_SEPARATORS.some((separator) => name.includes(separator))) {
    return false;
  }
  return name === name.trim();
}

/** Whether this document is one the vault can both accept and read. */
export function isSeedableFilename(name: string): boolean {
  if (!isSafeFilename(name)) {
    return false;
  }
  const lower = name.toLowerCase();
  return SEED_DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** One document chosen from the system picker, not yet read. */
export interface PickedDocument {
  /** The document's own name; its extension selects the vault's ingestor. */
  name: string;
  /** The on-device file uri the read step opens. */
  uri: string;
  /** Size in bytes when the picker reported one, else null. */
  size: number | null;
  /** Whether the vault can read this format under a name it accepts. */
  seedable: boolean;
}

/**
 * The outcome of a pick, discriminated on `kind`:
 *
 *  - `cancelled` — the person backed out of the picker.
 *  - `failed`    — the pick completed but yielded no document with a file uri.
 *  - `picked`    — one or more documents, in selection order.
 */
export type SeedPickResult =
  { kind: 'cancelled' } | { kind: 'failed' } | { kind: 'picked'; documents: PickedDocument[] };

/** Keep only assets carrying a file uri, mapping each in selection order. */
function toPickedDocuments(assets: readonly DocumentPicker.DocumentPickerAsset[]) {
  const documents: PickedDocument[] = [];
  for (const asset of assets) {
    if (asset.uri) {
      documents.push({
        name: asset.name,
        uri: asset.uri,
        size: asset.size ?? null,
        seedable: isSeedableFilename(asset.name),
      });
    }
  }
  return documents;
}

/**
 * Open the system file browser for a multi-selection and return the chosen
 * documents. A dismissed dialog is `cancelled`; a selection that yields no
 * usable file uri is `failed`. Documents the vault has no ingestor for are
 * returned too, flagged `seedable: false`, so the run can say so per file
 * rather than quietly dropping them.
 */
export async function pickSeedDocuments(): Promise<SeedPickResult> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) {
    return { kind: 'cancelled' };
  }
  const documents = toPickedDocuments(result.assets);
  if (documents.length === 0) {
    return { kind: 'failed' };
  }
  return { kind: 'picked', documents };
}
