/** Line that opens and closes a YAML frontmatter block: a lone triple-dash. */
const FRONTMATTER_FENCE = '---';

/** UTF-8 byte-order mark some editors prepend; tolerated before the fence. */
const BOM = '﻿';

/**
 * Drop a leading ``---``-delimited YAML frontmatter block from Markdown,
 * mirroring the backend algorithm: only a fence on line 1 (after an optional
 * BOM) counts; a ``---`` after prose is a thematic break and is preserved.
 * When there is no opening fence, or the block is never closed, the input is
 * returned character-for-character so nothing is silently swallowed.
 */
export function stripFrontmatter(md: string): string {
  const body = md.startsWith(BOM) ? md.slice(BOM.length) : md;
  const lines = body.split('\n');
  const firstLine = lines[0] ?? '';
  if (firstLine.trimEnd() !== FRONTMATTER_FENCE) {
    return md;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.trimEnd() === FRONTMATTER_FENCE) {
      return lines.slice(index + 1).join('\n');
    }
  }
  return md;
}
