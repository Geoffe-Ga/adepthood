/**
 * Lets a person choose a whole folder (an Obsidian vault, say) on the web, and
 * hands back every file in it with its path under that folder (#3555).
 *
 * The browser grants this through a file input marked `webkitdirectory`, opened
 * by the person's own tap. It gives no file content and no filesystem access
 * beyond the folder they chose: each `File` arrives with a
 * `webkitRelativePath` such as `My Vault/Work/Index.md`, and nothing is read
 * until the import sends that one document.
 *
 * Native platforms and browsers without directory inputs answer `unavailable`.
 * They keep the ordinary file picker; nothing here pretends to walk a folder
 * the platform has not opened. The DOM is reached only through the small
 * {@link FolderPickerHost} seam, so shared native code never touches it and
 * tests can drive the adapter without a browser.
 */
import { Platform } from 'react-native';

/** The parts of a directory-capable `<input type="file">` the adapter uses. */
export interface DirectoryInputLike<F> {
  type: string;
  multiple: boolean;
  webkitdirectory: boolean;
  readonly files: ArrayLike<F> | null;
  addEventListener(type: 'change' | 'cancel', listener: () => void): void;
  click(): void;
  remove(): void;
}

/** Where a directory input comes from; null where none can be built. */
export interface FolderPickerHost<F> {
  createDirectoryInput(): DirectoryInputLike<F> | null;
}

/**
 * The outcome of choosing a folder, discriminated on `kind`:
 *
 *  - `unavailable` — this platform cannot choose a folder; nothing was opened.
 *  - `cancelled`   — the person dismissed the dialog.
 *  - `picked`      — every file the folder held, unread, in the browser's order.
 */
export type SeedFolderPickResult<F> =
  { kind: 'unavailable' } | { kind: 'cancelled' } | { kind: 'picked'; files: F[] };

/** The slice of `document` the browser host needs. */
export interface DocumentLike {
  createElement(tagName: 'input'): unknown;
  readonly body: { appendChild(node: unknown): unknown } | null;
}

/** A directory input that is also a page element, so it can be hidden and attached. */
type DirectoryElement = DirectoryInputLike<File> & { style: { display: string } };

const INPUT_TAG = 'input';
const HIDDEN_DISPLAY = 'none';

/** Whether a freshly built input is one the browser lets choose a directory. */
function isDirectoryElement(element: unknown): element is DirectoryElement {
  return typeof element === 'object' && element !== null && 'webkitdirectory' in element;
}

/** The page's `document`, when there is one. */
function pageDocument(): DocumentLike | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

/**
 * The browser's folder picker, or null where there is none: on native, with no
 * document, or on a browser whose inputs cannot choose a directory.
 */
export function browserFolderPickerHost(
  doc: DocumentLike | undefined = pageDocument(),
): FolderPickerHost<File> | null {
  if (Platform.OS !== 'web' || doc === undefined) return null;
  if (!isDirectoryElement(doc.createElement(INPUT_TAG))) return null;
  return {
    createDirectoryInput: () => {
      const element = doc.createElement(INPUT_TAG);
      if (!isDirectoryElement(element)) return null;
      // Attached but hidden: some browsers only deliver `change` to an input
      // that is part of the page.
      element.style.display = HIDDEN_DISPLAY;
      doc.body?.appendChild(element);
      return element;
    },
  };
}

/**
 * Open the folder dialog and resolve with what came back. Must be called from
 * the person's own tap: browsers open file dialogs for nothing else.
 *
 * The dialog settles once. `cancel` (fired by current browsers when the dialog
 * is dismissed) and `change` race, and whichever lands first wins.
 */
export function pickSeedFolder<F>(
  host: FolderPickerHost<F> | null,
): Promise<SeedFolderPickResult<F>> {
  const input = host?.createDirectoryInput() ?? null;
  if (input === null) return Promise.resolve({ kind: 'unavailable' });
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: SeedFolderPickResult<F>): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(result);
    };
    input.addEventListener('change', () => {
      const files = input.files;
      settle(files === null ? { kind: 'cancelled' } : { kind: 'picked', files: Array.from(files) });
    });
    input.addEventListener('cancel', () => settle({ kind: 'cancelled' }));
    input.click();
  });
}
