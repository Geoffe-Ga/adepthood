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
  /**
   * Call `listener` whenever the page regains focus, as it does when a file
   * dialog closes; returns a function that stops watching. Absent where focus
   * cannot be watched.
   */
  watchFocusReturn?(listener: () => void): () => void;
}

/**
 * How long after focus returns a dialog may still deliver its files before it
 * is taken as dismissed. Browsers that never fire `cancel` give no other sign
 * of a dismissal, and `change` can trail the focus by a beat while a large
 * folder is listed.
 */
export const FOCUS_RETURN_SETTLE_MS = 1000;

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

/** The slice of `window` the browser host needs to notice focus returning. */
export interface WindowLike {
  addEventListener(type: 'focus', listener: () => void): void;
  removeEventListener(type: 'focus', listener: () => void): void;
}

/** A directory input that is also a page element, so it can be hidden and attached. */
type DirectoryElement = DirectoryInputLike<File> & { style: { display: string } };

const INPUT_TAG = 'input';
const HIDDEN_DISPLAY = 'none';
const FOCUS_EVENT = 'focus';

/** A dialog still open from an earlier tap, settled as cancelled when another starts. */
let abandonOpenPick: (() => void) | null = null;

/** Whether a freshly built input is one the browser lets choose a directory. */
function isDirectoryElement(element: unknown): element is DirectoryElement {
  return typeof element === 'object' && element !== null && 'webkitdirectory' in element;
}

/** The page's `document`, when there is one. */
function pageDocument(): DocumentLike | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

/** The page's `window`, when there is one. */
function pageWindow(): WindowLike | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

/** Watch `win` for focus returning, or nothing where there is no window. */
function focusWatcher(win: WindowLike | undefined): FolderPickerHost<File>['watchFocusReturn'] {
  if (win === undefined) return undefined;
  return (listener) => {
    win.addEventListener(FOCUS_EVENT, listener);
    return () => win.removeEventListener(FOCUS_EVENT, listener);
  };
}

/**
 * The browser's folder picker, or null where there is none: on native, with no
 * document, or on a browser whose inputs cannot choose a directory.
 */
export function browserFolderPickerHost(
  doc: DocumentLike | undefined = pageDocument(),
  win: WindowLike | undefined = pageWindow(),
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
    watchFocusReturn: focusWatcher(win),
  };
}

/**
 * Open the folder dialog and resolve with what came back. Must be called from
 * the person's own tap: browsers open file dialogs for nothing else.
 *
 * The dialog settles once, and releases its input whichever way it settles.
 * `cancel` (fired by current browsers when the dialog is dismissed) and
 * `change` race, and whichever lands first wins. Where `cancel` never fires,
 * focus returning with no files within {@link FOCUS_RETURN_SETTLE_MS} counts as
 * a dismissal, and so does a new pick starting while this one is still open,
 * so no dismissed dialog leaves its input behind on the page.
 */
export function pickSeedFolder<F>(
  host: FolderPickerHost<F> | null,
): Promise<SeedFolderPickResult<F>> {
  abandonOpenPick?.();
  const input = host?.createDirectoryInput() ?? null;
  if (host === null || input === null) return Promise.resolve({ kind: 'unavailable' });
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SeedFolderPickResult<F>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWatching?.();
      if (abandonOpenPick === cancel) abandonOpenPick = null;
      input.remove();
      resolve(result);
    };
    const cancel = (): void => settle({ kind: 'cancelled' });
    const stopWatching = host.watchFocusReturn?.(() => {
      clearTimeout(timer);
      timer = setTimeout(cancel, FOCUS_RETURN_SETTLE_MS);
    });
    abandonOpenPick = cancel;
    input.addEventListener('change', () => {
      const files = input.files;
      settle(files === null ? { kind: 'cancelled' } : { kind: 'picked', files: Array.from(files) });
    });
    input.addEventListener('cancel', cancel);
    input.click();
  });
}
