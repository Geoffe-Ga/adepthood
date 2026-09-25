/**
 * The journal editor's commands, and the keys that name them.
 *
 * Pure: a key descriptor in, a command out; a command and the current body in,
 * a {@link CommandResult} out. The text field decides what to do with the
 * result, so this can be tested without a renderer and shared by the keyboard
 * and the touch toolbar.
 *
 * The three result kinds exist because the keyboard has to answer a question
 * the toolbar does not: whether to stop the browser's own handling of the key.
 * ``edit`` and ``consumed`` both claim the key; only ``pass`` lets it through.
 */
import type { InlineStyle } from './journalMarkdown';
import type { MarkdownEdit, MarkdownSelection } from './markdownEditing';
import { listLevelAt, shiftListLines, type ShiftDirection } from './markdownIndent';
import { inlineStyleActive, toggleInlineStyle } from './markdownInlineToggle';

/** What an editor action does: style the selection, or move its list items a level. */
export type MarkdownCommand = InlineStyle | ShiftDirection;

/** The parts of a keyboard event the dispatcher reads (a DOM KeyboardEvent fits). */
export interface MarkdownKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** The physical key (``KeyB``), independent of the layout. */
  code?: string;
}

/**
 * The modifier a platform's formatting shortcuts use: Command on Apple
 * platforms, Control elsewhere. Accepting both would steal macOS's own
 * Ctrl+B / Ctrl+I caret-movement keys.
 */
export type PrimaryModifier = 'meta' | 'ctrl';

/** The legacy keyCode browsers report for every keystroke inside an IME composition. */
export const IME_COMPOSITION_KEYCODE = 229;

const SHORTCUT_STYLES: Readonly<Record<string, InlineStyle>> = Object.freeze({
  b: 'bold',
  i: 'italic',
  u: 'underline',
});

/**
 * The same shortcuts by physical key, for layouts whose keys are not Latin
 * letters (Cyrillic, Greek, Hebrew, Arabic...): there Ctrl+B reports ``key``
 * 'и', and only ``code`` still says KeyB.
 */
const SHORTCUT_CODES: Readonly<Record<string, InlineStyle>> = Object.freeze({
  KeyB: 'bold',
  KeyI: 'italic',
  KeyU: 'underline',
});

/** A Latin letter: a layout that reports one means it, so ``code`` is not consulted. */
const LATIN_LETTER = /^[a-z]$/iu;

/** The outcome of running a command against the body. */
export type CommandResult =
  { kind: 'edit'; edit: MarkdownEdit } | { kind: 'consumed' } | { kind: 'pass' };

/** The editor state a toolbar reflects. */
export interface MarkdownCommandState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** The caret's list level (0 = flush), or null off a list line. */
  listLevel: number | null;
}

const TAB_KEY = 'Tab';

function isComposing(event: MarkdownKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === IME_COMPOSITION_KEYCODE;
}

/** The formatting shortcut a key names, or null for any other key. */
function shortcutCommand(
  event: MarkdownKeyEvent,
  primary: PrimaryModifier,
): MarkdownCommand | null {
  const primaryHeld = primary === 'meta' ? event.metaKey === true : event.ctrlKey === true;
  const otherHeld = primary === 'meta' ? event.ctrlKey === true : event.metaKey === true;
  if (!primaryHeld || otherHeld || event.shiftKey === true) return null;
  if (LATIN_LETTER.test(event.key)) return SHORTCUT_STYLES[event.key.toLowerCase()] ?? null;
  return event.code == null ? null : (SHORTCUT_CODES[event.code] ?? null);
}

/** Tab indents and Shift+Tab outdents; Tab with Ctrl or Cmd belongs to the browser. */
function tabCommand(event: MarkdownKeyEvent): MarkdownCommand | null {
  if (event.ctrlKey === true || event.metaKey === true) return null;
  return event.shiftKey === true ? 'outdent' : 'indent';
}

/**
 * The command a key names, or null when the key is not the editor's.
 *
 * Alt never maps (it composes characters on many layouts), and nothing maps
 * while an IME composition is active: those keystrokes belong to the IME.
 */
export function keyCommand(
  event: MarkdownKeyEvent,
  primary: PrimaryModifier,
): MarkdownCommand | null {
  if (isComposing(event) || event.altKey === true) return null;
  if (event.key === TAB_KEY) return tabCommand(event);
  return shortcutCommand(event, primary);
}

/** Run a command against the body at a UTF-16 selection. */
export function applyMarkdownCommand(
  body: string,
  selection: MarkdownSelection,
  command: MarkdownCommand,
): CommandResult {
  if (command === 'indent' || command === 'outdent') {
    // Nothing to move -- prose, or an outdent at level 0 -- lets the key
    // through, so Tab and Shift+Tab still move focus and never trap it.
    const shifted = shiftListLines(body, selection, command);
    return shifted == null ? { kind: 'pass' } : { kind: 'edit', edit: shifted };
  }
  const edit = toggleInlineStyle(body, selection, command);
  // A refused toggle still claims the key: the writer asked for formatting,
  // and the browser's own Cmd+B / Cmd+U would do something unrelated.
  return edit == null ? { kind: 'consumed' } : { kind: 'edit', edit };
}

/** What each command's control should show at this selection. */
export function markdownCommandState(
  body: string,
  selection: MarkdownSelection,
): MarkdownCommandState {
  return {
    bold: inlineStyleActive(body, selection, 'bold'),
    italic: inlineStyleActive(body, selection, 'italic'),
    underline: inlineStyleActive(body, selection, 'underline'),
    listLevel: listLevelAt(body, selection.start),
  };
}
