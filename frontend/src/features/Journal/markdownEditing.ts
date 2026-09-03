/**
 * Continue the lightweight Markdown block the writer is currently in.
 *
 * React Native's TextInput remains the source of truth so selection, dictation,
 * undo, and autosave all keep working. This adds the one editor convenience a
 * plain multiline field does not provide: Return after a list item or quote
 * carries its marker forward, while Return on an empty marker exits the block.
 */
export function continueMarkdownLine(previous: string, next: string): string {
  if (next !== `${previous}\n`) return next;
  const lineStart = previous.lastIndexOf('\n') + 1;
  const line = previous.slice(lineStart);
  const match = line.match(/^(\s*)([-*>])\s(.*)$/);
  if (match == null) return next;
  const indentation = match[1] ?? '';
  const marker = match[2] ?? '';
  const content = match[3] ?? '';
  if (content.length === 0) return previous.slice(0, lineStart);
  return `${next}${indentation}${marker} `;
}
