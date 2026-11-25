/**
 * Applying a batch of prefix replacements to a body, and carrying a selection
 * through them.
 *
 * The list commands -- nesting an item, renumbering a run -- each rewrite a few
 * short ranges at the front of their lines. They share this one application so
 * a selection is moved the same way whichever of them changed the text.
 */
import { codePointToUtf16 } from './codePoints';
import type { MarkdownEdit } from './markdownEditing';

/** One replacement, in code points: ``[start, end)`` becomes ``insert``. */
export interface SourceChange {
  start: number;
  end: number;
  insert: string;
}

/** A selection in code points, ``start`` at or before ``end``. */
export interface SourceRange {
  start: number;
  end: number;
}

/** Where a source position lands after the changes; one inside a replaced range clamps to its start. */
function remap(changes: readonly SourceChange[], position: number): number {
  let shifted = position;
  for (const change of changes) {
    const inserted = Array.from(change.insert).length;
    if (position >= change.end) shifted += inserted - (change.end - change.start);
    else if (position > change.start) shifted -= position - change.start;
  }
  return shifted;
}

/**
 * The body after ``changes``, with ``selection`` moved by what was inserted or
 * removed before it. The changes must not overlap and must be in source order.
 */
export function applySourceChanges(
  chars: readonly string[],
  changes: readonly SourceChange[],
  selection: SourceRange,
): MarkdownEdit {
  const next = [...chars];
  for (const change of [...changes].reverse()) {
    next.splice(change.start, change.end - change.start, ...Array.from(change.insert));
  }
  const text = next.join('');
  return {
    text,
    selection: {
      start: codePointToUtf16(text, remap(changes, selection.start)),
      end: codePointToUtf16(text, remap(changes, selection.end)),
    },
  };
}
