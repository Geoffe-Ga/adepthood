import { File, Paths } from 'expo-file-system';
import { Platform, Share } from 'react-native';

import { users, type DataExportArchive } from '@/api';

/**
 * Fetch one of the two export formats, put it on the device, and offer it to
 * the share sheet.
 *
 * The download is only half the feature. A file written into the app's own
 * document directory and never mentioned again is not a copy the user has —
 * it is a copy the app has, in a folder they cannot open. So every export ends
 * at the platform share sheet, which is where "keep this in iCloud / Drive /
 * mail it to myself" actually happens.
 *
 * Sharing is best-effort: if the sheet is unavailable or dismissed, the file
 * is still written and the screen still names it, because a failed share is
 * not a failed export.
 */

/** The two things an export can be. */
export type ExportFormat = 'json' | 'markdown';

/** The platform handoff that made the completed export reachable. */
export type ExportDestination = 'browser-download' | 'shared' | 'device-file';

/** What one completed export produced. */
export interface SavedExport {
  /** The name the file was written under, which the receipt shows the user. */
  filename: string;
  /** Its on-device URI on native; browser object URLs are released immediately. */
  uri: string | null;
  /** Rows in the archive; ``null`` for Markdown, which is prose, not records. */
  records: number | null;
  /** Where the person can retrieve the completed copy. */
  destination: ExportDestination;
}

/** Title the share sheet shows above the file. */
const SHARE_TITLE = 'Your Adepthood data';

/** Length of an ISO-8601 date, used to date the filename. */
const ISO_DATE_LENGTH = 10;

function today(): string {
  return new Date().toISOString().slice(0, ISO_DATE_LENGTH);
}

/** How many rows an archive carries, across every collection in it. */
export function countRecords(archive: DataExportArchive): number {
  return Object.values(archive.records).reduce((total, rows) => total + rows.length, 0);
}

/**
 * Write one text file into the document directory, replacing any earlier copy.
 *
 * Two exports on the same day overwrite rather than accumulating
 * ``…(1).json`` — the file is a snapshot of everything, so the older one has
 * nothing in it the newer one lacks.
 */
function writeTextFile(filename: string, contents: string): File {
  const file = new File(Paths.document, filename);
  file.create({ overwrite: true, intermediates: true });
  file.write(contents);
  return file;
}

interface DownloadAnchor {
  href: string;
  download: string;
  click: () => void;
  remove: () => void;
}

interface WebDownloadHost {
  Blob?: new (_parts: string[], _options: { type: string }) => unknown;
  URL?: {
    createObjectURL?: (_value: unknown) => string;
    revokeObjectURL?: (_value: string) => void;
  };
  document?: {
    createElement?: (_tag: 'a') => DownloadAnchor;
    body?: { appendChild: (_anchor: DownloadAnchor) => void };
  };
}

/** Hand the bytes to the browser without touching Expo's native-only File API. */
function downloadOnWeb(filename: string, contents: string, mediaType: string): void {
  const host = globalThis as unknown as WebDownloadHost;
  const createObjectURL = host.URL?.createObjectURL;
  const revokeObjectURL = host.URL?.revokeObjectURL;
  const createElement = host.document?.createElement;
  const body = host.document?.body;
  if (!host.Blob || !createObjectURL || !revokeObjectURL || !createElement || !body) {
    throw new Error('browser download is unavailable');
  }

  const objectUrl = createObjectURL(new host.Blob([contents], { type: mediaType }));
  try {
    const anchor = createElement.call(host.document, 'a');
    anchor.href = objectUrl;
    anchor.download = filename;
    body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    revokeObjectURL.call(host.URL, objectUrl);
  }
}

/** Offer a written file to the platform share sheet; never throw. */
async function offerToShare(uri: string): Promise<boolean> {
  try {
    const result = await Share.share({ url: uri, title: SHARE_TITLE });
    return result.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}

/** The JSON archive: everything, in a form that can be read back in. */
async function fetchJsonExport(): Promise<{ contents: string; records: number }> {
  const archive = await users.exportMyData();
  return { contents: JSON.stringify(archive, null, 2), records: countRecords(archive) };
}

/** The Markdown journal: the half a person opens and reads. */
async function fetchMarkdownExport(): Promise<{ contents: string; records: null }> {
  return { contents: await users.exportMyJournalAsMarkdown(), records: null };
}

const FORMATS = {
  json: {
    filename: 'adepthood-export',
    extension: 'json',
    mediaType: 'application/json;charset=utf-8',
    fetch: fetchJsonExport,
  },
  markdown: {
    filename: 'adepthood-journal',
    extension: 'md',
    mediaType: 'text/markdown;charset=utf-8',
    fetch: fetchMarkdownExport,
  },
} as const;

/**
 * Download one export format, save it, and hand it to the share sheet.
 *
 * Throws whatever the API client throws — the caller shows the message. It
 * deliberately does not catch a failed download and pretend a file was
 * written; an export that quietly saved nothing is the one failure a person
 * would not discover until they needed the file.
 */
export async function saveDataExport(format: ExportFormat): Promise<SavedExport> {
  const spec = FORMATS[format];
  const { contents, records } = await spec.fetch();
  const filename = `${spec.filename}-${today()}.${spec.extension}`;
  if (Platform.OS === 'web') {
    downloadOnWeb(filename, contents, spec.mediaType);
    return { filename, uri: null, records, destination: 'browser-download' };
  }
  const file = writeTextFile(filename, contents);
  const shared = await offerToShare(file.uri);
  return {
    filename,
    uri: file.uri,
    records,
    destination: shared ? 'shared' : 'device-file',
  };
}
