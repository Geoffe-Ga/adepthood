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
