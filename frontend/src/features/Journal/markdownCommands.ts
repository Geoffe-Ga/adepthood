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
import { inlineStyleActive, toggleInlineStyle } from './markdownInlineToggle';

/** What an editor action does. */
export type MarkdownCommand = InlineStyle;

/** The parts of a keyboard event the dispatcher reads (a DOM KeyboardEvent fits). */
export interface MarkdownKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
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

/** The outcome of running a command against the body. */
export type CommandResult =
  { kind: 'edit'; edit: MarkdownEdit } | { kind: 'consumed' } | { kind: 'pass' };

/** The editor state a toolbar reflects. */
export interface MarkdownCommandState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

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
  return SHORTCUT_STYLES[event.key.toLowerCase()] ?? null;
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
  return shortcutCommand(event, primary);
}

/** Run a command against the body at a UTF-16 selection. */
export function applyMarkdownCommand(
  body: string,
  selection: MarkdownSelection,
  command: MarkdownCommand,
): CommandResult {
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
  };
}
