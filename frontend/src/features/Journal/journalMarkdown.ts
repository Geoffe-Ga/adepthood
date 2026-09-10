/**
 * The journal's deliberately small Markdown dialect.
 *
 * Entries stay as the exact source the writer typed because marginalia and
 * promoted quotes address that source in Unicode code-point offsets. This
 * parser therefore describes presentation without rewriting the body: marker
 * characters are hidden at render time and every visible run retains its
 * original source range.
 */

export interface JournalMarkdownRun {
  /** Code-point range in the original journal body. */
  start: number;
  end: number;
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface JournalMarkdownLine {
  /** Full source range for the line. */
  start: number;
  /** First normally visible source position (after `> ` for quote lines). */
  contentStart: number;
  end: number;
}

export interface JournalMarkdownBlock {
  /** Code-point index of the first line, used for stable keys and test IDs. */
  start: number;
  quote: boolean;
  lines: JournalMarkdownLine[];
}

interface CharacterFormat {
  visible: boolean;
  bold: boolean;
  italic: boolean;
}

export interface JournalMarkdownDocument {
  chars: string[];
  formats: CharacterFormat[];
  blocks: JournalMarkdownBlock[];
}

interface SourceLine {
  start: number;
  end: number;
}

/** Split in code-point space, preserving a final empty line after a trailing LF. */
function sourceLines(chars: string[]): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== '\n') continue;
    lines.push({ start, end: index });
    start = index + 1;
  }
  lines.push({ start, end: chars.length });
  return lines;
}

/** `> text` and a bare `>` are quote lines; `>text` remains ordinary prose. */
function describeLine(chars: string[], line: SourceLine): JournalMarkdownLine & { quote: boolean } {
  const first = chars[line.start];
  const second = chars[line.start + 1];
  const quote = first === '>' && (line.start + 1 === line.end || second === ' ');
  return {
    start: line.start,
    contentStart: quote ? Math.min(line.start + (second === ' ' ? 2 : 1), line.end) : line.start,
    end: line.end,
    quote,
  };
}

/** Gather adjacent lines of the same kind so a multi-line quotation is one block. */
function buildBlocks(chars: string[]): JournalMarkdownBlock[] {
  const blocks: JournalMarkdownBlock[] = [];
  for (const source of sourceLines(chars)) {
    const { quote, start, contentStart, end } = describeLine(chars, source);
    const current = blocks.at(-1);
    if (current != null && current.quote === quote) {
      current.lines.push({ start, contentStart, end });
    } else {
      blocks.push({ start: source.start, quote, lines: [{ start, contentStart, end }] });
    }
  }
  return blocks;
}

/** True when a marker is escaped by an odd run of immediately preceding slashes. */
function isEscaped(chars: string[], index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && chars[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isWhitespace(char: string | undefined): boolean {
  return char == null || /\s/u.test(char);
}

/** Underscores inside a word are prose (`snake_case`), not emphasis markers. */
function hasWordBoundary(chars: string[], index: number, width: number, opening: boolean): boolean {
  if (chars[index] !== '_') return true;
  const outside = opening ? chars[index - 1] : chars[index + width];
  return outside == null || !/[\p{L}\p{N}]/u.test(outside);
}

function isMarkerRun(chars: string[], index: number, marker: string, width: number): boolean {
  for (let offset = 0; offset < width; offset += 1) {
    if (chars[index + offset] !== marker) return false;
  }
  return chars[index - 1] !== marker && chars[index + width] !== marker;
}

/** Find the next syntactically usable closing marker on this source line. */
function findClosingMarker(
  chars: string[],
  start: number,
  end: number,
  marker: string,
  width: number,
): number | null {
  for (let index = start; index + width <= end; index += 1) {
    if (!isMarkerRun(chars, index, marker, width) || isEscaped(chars, index)) continue;
    if (isWhitespace(chars[index - 1])) continue;
    if (!hasWordBoundary(chars, index, width, false)) continue;
    return index;
  }
  return null;
}

/** A marker can open only when it is whole, unescaped, and touches content. */
function isOpeningMarker(
  chars: string[],
  index: number,
  marker: '*' | '_',
  width: number,
): boolean {
  return (
    isMarkerRun(chars, index, marker, width) &&
    !isEscaped(chars, index) &&
    !isWhitespace(chars[index + width]) &&
    hasWordBoundary(chars, index, width, true)
  );
}

/** Apply one delimiter width without consuming or changing the stored source. */
function applyDelimitedStyle(
  chars: string[],
  formats: CharacterFormat[],
  line: JournalMarkdownLine,
  marker: '*' | '_',
  width: number,
  style: 'bold' | 'italic',
): void {
  let index = line.contentStart;
  while (index + width < line.end) {
    if (!isOpeningMarker(chars, index, marker, width)) {
      index += 1;
      continue;
    }
    const close = findClosingMarker(chars, index + width + 1, line.end, marker, width);
    if (close == null) {
      index += width;
      continue;
    }
    for (let markerIndex = 0; markerIndex < width; markerIndex += 1) {
      formats[index + markerIndex]!.visible = false;
      formats[close + markerIndex]!.visible = false;
    }
    for (let contentIndex = index + width; contentIndex < close; contentIndex += 1) {
      formats[contentIndex]![style] = true;
    }
    index = close + width;
  }
}

function continuesRun(
  document: JournalMarkdownDocument,
  index: number,
  end: number,
  format: CharacterFormat,
): boolean {
  const candidate = document.formats[index];
  return (
    index < end &&
    candidate?.visible === true &&
    candidate.bold === format.bold &&
    candidate.italic === format.italic
  );
}

/** Apply inline styles independently so `*_both_*` composes naturally. */
function applyInlineFormatting(
  chars: string[],
  formats: CharacterFormat[],
  blocks: JournalMarkdownBlock[],
): void {
  for (const block of blocks) {
    for (const line of block.lines) {
      applyDelimitedStyle(chars, formats, line, '*', 2, 'bold');
      applyDelimitedStyle(chars, formats, line, '*', 1, 'bold');
      applyDelimitedStyle(chars, formats, line, '_', 2, 'bold');
      applyDelimitedStyle(chars, formats, line, '_', 1, 'italic');
    }
  }
}

/** Hide quote prefixes while retaining them in the source-offset stream. */
function hideQuotePrefixes(formats: CharacterFormat[], blocks: JournalMarkdownBlock[]): void {
  for (const block of blocks) {
    if (!block.quote) continue;
    for (const line of block.lines) {
      for (let index = line.start; index < line.contentStart; index += 1) {
        formats[index]!.visible = false;
      }
    }
  }
}

/** Parse a journal body for read-mode presentation, retaining raw source offsets. */
export function parseJournalMarkdown(body: string): JournalMarkdownDocument {
  const chars = Array.from(body);
  const formats = chars.map(() => ({ visible: true, bold: false, italic: false }));
  const blocks = buildBlocks(chars);
  hideQuotePrefixes(formats, blocks);
  applyInlineFormatting(chars, formats, blocks);
  return { chars, formats, blocks };
}

/** Visible, equally styled runs inside one raw-source interval. */
export function markdownRuns(
  document: JournalMarkdownDocument,
  start: number,
  end: number,
): JournalMarkdownRun[] {
  const runs: JournalMarkdownRun[] = [];
  let index = start;
  while (index < end) {
    const format = document.formats[index];
    if (format == null || !format.visible) {
      index += 1;
      continue;
    }
    const runStart = index;
    const text: string[] = [];
    while (continuesRun(document, index, end, format)) {
      text.push(document.chars[index]!);
      index += 1;
    }
    runs.push({
      start: runStart,
      end: index,
      text: text.join(''),
      bold: format.bold,
      italic: format.italic,
    });
  }
  return runs;
}
