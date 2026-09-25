/**
 * Apply an editor command to the web ``<textarea>`` the way a browser edit is
 * applied, so the browser's own undo (Cmd/Ctrl+Z) can take it back.
 *
 * Writing a controlled value from React replaces the textarea's content
 * wholesale and drops it from the native undo stack; a writer who pressed
 * Cmd+B and then Cmd+Z would lose unrelated typing instead. The toolbar-free
 * editor pattern (GitHub's markdown-toolbar-element) is to select the range
 * that changes and ``execCommand('insertText')`` over it, which the browser
 * records as one undoable step and reports through the ordinary ``input``
 * event -- so the change still reaches the app through ``onChangeText``.
 *
 * Returns false whenever that path is unavailable or did not produce exactly
 * the expected text; the caller then applies the edit as a controlled value.
 */
import { minimalReplacement, type MarkdownEdit } from './markdownEditing';

interface EditableTextNode {
  value: string;
  setSelectionRange: (start: number, end: number) => void;
}

interface CommandDocument {
  execCommand?: (command: string, showUI: boolean, value?: string) => boolean;
}

function isEditable(node: unknown): node is EditableTextNode {
  if (node == null || typeof node !== 'object') return false;
  const candidate = node as Partial<EditableTextNode>;
  return typeof candidate.value === 'string' && typeof candidate.setSelectionRange === 'function';
}

/** Apply ``edit`` to a web textarea node through the browser's editing commands. */
export function applyEditToTextarea(node: unknown, edit: MarkdownEdit): boolean {
  const doc = (globalThis as { document?: CommandDocument }).document;
  if (!isEditable(node) || doc == null || typeof doc.execCommand !== 'function') return false;
  const replacement = minimalReplacement(node.value, edit.text);
  if (replacement.start !== replacement.end || replacement.text !== '') {
    node.setSelectionRange(replacement.start, replacement.end);
    const applied =
      replacement.text === ''
        ? doc.execCommand('delete', false)
        : doc.execCommand('insertText', false, replacement.text);
    if (!applied || node.value !== edit.text) return false;
  }
  if (edit.selection) node.setSelectionRange(edit.selection.start, edit.selection.end);
  return true;
}
