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

/** ATX H1 prefix: exactly one hash followed by a space. */
const H1_PREFIX = '# ';

/**
 * Drop a leading ``# Heading`` line when its text exactly matches the manifest
 * ``title`` — the reader already renders the title in its sheet header, so a
 * duplicate H1 would read twice.  Only the first non-empty line is considered,
 * it must be a single-hash ATX H1, and a differing heading is left untouched.
 * A blank line immediately after the stripped heading is consumed too.
 */
export function stripLeadingTitleHeading(md: string, title: string): string {
  const lines = md.split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex === -1) {
    return md;
  }
  const heading = lines[firstContentIndex] ?? '';
  if (!heading.startsWith(H1_PREFIX)) {
    return md;
  }
  const headingText = heading.slice(H1_PREFIX.length).trim();
  if (headingText !== title.trim()) {
    return md;
  }
  let nextIndex = firstContentIndex + 1;
  if (lines[nextIndex]?.trim() === '') {
    nextIndex += 1;
  }
  return lines.slice(nextIndex).join('\n');
}
