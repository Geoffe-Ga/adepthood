export interface MarkdownEdit {
  text: string;
  /** Native TextInput offsets are UTF-16 string indices, as are these values. */
  selection?: MarkdownSelection;
}

export interface MarkdownSelection {
  start: number;
  end: number;
}

/** Whether ``next`` is exactly ``previous`` with one line feed inserted at ``index``. */
function isLineFeedInsertionAt(previous: string, next: string, index: number): boolean {
  return (
    next[index] === '\n' &&
    next.slice(0, index) === previous.slice(0, index) &&
    next.slice(index + 1) === previous.slice(index)
  );
}

/** Return the index of one newly inserted line feed, or null for any other edit. */
function insertedLineFeed(
  previous: string,
  next: string,
  previousSelection?: MarkdownSelection,
): number | null {
  if (next.length !== previous.length + 1) return null;
  if (
    previousSelection != null &&
    previousSelection.start === previousSelection.end &&
    isLineFeedInsertionAt(previous, next, previousSelection.start)
  ) {
    return previousSelection.start;
  }
  let sharedSuffix = 0;
  while (
    sharedSuffix < previous.length &&
    previous[previous.length - 1 - sharedSuffix] === next[next.length - 1 - sharedSuffix]
  ) {
    sharedSuffix += 1;
  }
  const index = next.length - 1 - sharedSuffix;
  return isLineFeedInsertionAt(previous, next, index) ? index : null;
}

/**
 * Continue the lightweight Markdown block at the actual caret.
 *
 * React Native's TextInput remains the source of truth so selection, dictation,
 * undo, and autosave all keep working. This adds the one editor convenience a
 * plain multiline field does not provide: Return after a list item or quote
 * carries its marker forward, while Return on an empty marker exits the block.
 */
export function continueMarkdownEdit(
  previous: string,
  next: string,
  previousSelection?: MarkdownSelection,
): MarkdownEdit {
  const newlineIndex = insertedLineFeed(previous, next, previousSelection);
  if (newlineIndex == null) return { text: next };

  const lineStart = previous.lastIndexOf('\n', newlineIndex - 1) + 1;
  const line = previous.slice(lineStart, newlineIndex);
  const match = line.match(/^(\s*)([-*+>])\s(.*)$/);
  if (match == null) return { text: next };
  const indentation = match[1] ?? '';
  const marker = match[2] ?? '';
  const content = match[3] ?? '';
  if (content.length === 0) {
    const text = `${next.slice(0, lineStart)}${next.slice(newlineIndex + 1)}`;
    return { text, selection: { start: lineStart, end: lineStart } };
  }

  const prefix = `${indentation}${marker} `;
  const caret = newlineIndex + 1 + prefix.length;
  return {
    text: `${next.slice(0, newlineIndex + 1)}${prefix}${next.slice(newlineIndex + 1)}`,
    selection: { start: caret, end: caret },
  };
}

/** String-only compatibility helper for callers that do not control a caret. */
export function continueMarkdownLine(previous: string, next: string): string {
  return continueMarkdownEdit(previous, next).text;
}
