/** Deepest ATX heading level Markdown recognises (one to six hashes). */
const MAX_ATX_DEPTH = 6;

/** Leading ATX heading: one to six hashes followed by a single space. */
const ATX_HEADING_PREFIX = new RegExp(`^#{1,${MAX_ATX_DEPTH}} `);

/**
 * Drop a leading ATX heading of any level (1-6 hashes) when its text exactly
 * matches the manifest ``title`` -- the reader already renders the title in its
 * sheet header, so a duplicate heading would read twice.  Only the first
 * non-empty line is considered, it must be a valid ATX heading whose trimmed
 * text equals the trimmed title, and a differing heading is left untouched.
 * A blank line immediately after the stripped heading is consumed too.
 */
export function stripLeadingTitleHeading(md: string, title: string): string {
  const lines = md.split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex === -1) {
    return md;
  }
  const heading = lines[firstContentIndex] ?? '';
  const match = ATX_HEADING_PREFIX.exec(heading);
  if (match === null) {
    return md;
  }
  const headingText = heading.slice(match[0].length).trim();
  if (headingText !== title.trim()) {
    return md;
  }
  let nextIndex = firstContentIndex + 1;
  if (lines[nextIndex]?.trim() === '') {
    nextIndex += 1;
  }
  return lines.slice(nextIndex).join('\n');
}
