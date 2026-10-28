/**
 * The shared vocabulary of the journal's Markdown model.
 *
 * These types live apart from the parser so the line model, the inline
 * formatter, the caret mapping, and the facade can all speak them without an
 * import cycle. Every offset in this file is a **source position**: a Unicode
 * code-point index into the exact stored body, which is the same number the
 * marginalia / promoted-quote anchor API uses (see ``codePoints.ts``).
 */

/**
 * How the renderer treats a line, once its opening marker is read.
 *
 * ``heading`` is an ATX ``#``-``######`` heading, ``ordered`` a ``1.`` / ``1)``
 * item, ``task`` a bullet carrying a ``[ ]`` / ``[x]`` checkbox, and ``rule`` a
 * line that is only ``---``, ``***`` or ``___``. {@link classifyLine} is the only
 * place any of them is recognised.
 */
export type LineKind = 'quote' | 'bullet' | 'ordered' | 'task' | 'heading' | 'rule' | 'plain';

/**
 * What separates a line's opening marker from its content.
 *
 * The editor and the renderer deliberately accept different sets, which is why
 * this is reported rather than folded into {@link LineKind}: the renderer draws
 * a block only for a literal-space separator (and a bare ``>``), while the
 * editor also carries a tab-separated marker forward on Return. Collapsing the
 * two would either delete a writer's bare ``>`` or stop continuing ``-\tfoo``.
 */
export type MarkerFollowedBy = 'space' | 'tab' | 'none' | 'eol';

/** One source line, classified. All offsets are source positions. */
export interface JournalMarkdownLine {
  /** Full source range for the line. */
  start: number;
  /** First normally visible source position (after `> ` or `- ` on a marked line). */
  contentStart: number;
  end: number;
  /** How the renderer treats this line. */
  kind: LineKind;
  /**
   * The opening marker exactly as typed -- ``>`` or one of ``BULLET_MARKERS`` --
   * or null when the line opens with neither. These are the markers the editor
   * carries forward on Return; a heading's ``#`` run and an ordered item's
   * digits are deliberately NOT reported here (so Return keeps its shipped
   * behaviour) and are read from ``contentStart`` and the fields below instead.
   * A task line reports its bullet marker.
   */
  marker: string | null;
  /** What follows that marker. */
  markerFollowedBy: MarkerFollowedBy;
  /**
   * Source position just past the marker and its separator, whenever the line
   * opens with a marker at all -- even one the renderer treats as prose, such as
   * ``-\tfoo`` or ``>text``. This is the lexical reading the editor works from;
   * ``contentStart`` is the render reading and equals ``start`` on a plain line.
   */
  markerEnd: number;
  /** Source range of the leading indent is ``[start, indentEnd)``. */
  indentEnd: number;
  /** Indent measured in columns, tabs counted as ``JOURNAL_TAB_COLUMNS``. */
  indentWidth: number;
  /** 1-6 on a heading line, null on every other kind. */
  headingLevel: number | null;
  /** The ordered item's number as typed (``007.`` is 7), null on every other kind. */
  ordinal: number | null;
  /** Whether a task line's box is checked, null on every other kind. */
  taskChecked: boolean | null;
}

/**
 * Adjacent lines of one kind, rendered as a single block element. A heading
 * or a rule is always a block of its own line: each draws its own element.
 */
export interface JournalMarkdownBlock {
  /** Code-point index of the first line, used for stable keys and test IDs. */
  start: number;
  /** Retained alongside ``kind`` so existing quote consumers keep working. */
  quote: boolean;
  kind: LineKind;
  lines: JournalMarkdownLine[];
}

/**
 * Presentation of one source character.
 *
 * ``visible: false`` means transparent-but-present: the character stays in the
 * source stream at its own offset and presentation may dim or erase its glyph.
 * It never means the character was removed.
 */
export interface CharacterFormat {
  visible: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/** The style one delimiter pair carries. */
export type InlineStyle = 'bold' | 'italic' | 'underline';

/**
 * One matched delimiter pair and the source range it owns.
 *
 * A {@link CharacterFormat} records only that a character is hidden, never WHY,
 * so ``visible: false`` alone cannot tell a bullet's ``- `` from an emphasis
 * ``**`` -- nor one span's closing delimiter from the next span's opening one.
 * These records are the ownership the caret geometry reads: ``start`` is the
 * opening delimiter's first source position and ``end`` is one past the closing
 * delimiter's last, so a block prefix is never inside any of them.
 */
export interface InlineSpan {
  start: number;
  end: number;
  /**
   * The styled content is ``[contentStart, contentEnd)``: the delimiters are
   * ``[start, contentStart)`` and ``[contentEnd, end)``. Recorded because one
   * style has several spellings of different widths (``*``, ``**``, ``__``) and
   * an asymmetric one (``<u>…</u>``), so an editor removing a pair must read
   * the widths the parser matched rather than assume them.
   */
  contentStart: number;
  contentEnd: number;
  style: InlineStyle;
}

/** A parsed body: the source stream plus the views derived from it. */
export interface JournalMarkdownDocument {
  /** The ONLY stored representation of the body, in code-point order. */
  chars: string[];
  formats: CharacterFormat[];
  blocks: JournalMarkdownBlock[];
  /**
   * Distinct non-zero indent widths of the document's bullet and task lines, ascending.
   *
   * Exposed so a Tab/outdent feature can infer this document's indent unit
   * without re-parsing. This model exposes the measurement; it does not choose
   * the unit.
   */
  indentWidths: number[];
  /**
   * Every delimiter pair the inline passes matched, in the order they matched.
   *
   * Recorded rather than re-derived because the format stream cannot be walked
   * back into spans: adjacent hidden characters may belong to two different
   * spans, or to a block prefix that is not a span at all.
   */
  inlineSpans: InlineSpan[];
}

/** A stretch of equally formatted characters inside one source interval. */
export interface JournalMarkdownRun {
  /** Code-point range in the original journal body. */
  start: number;
  end: number;
  text: string;
  /** False only in a ``sourceRuns`` stream; ``markdownRuns`` yields visible runs. */
  visible: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/** A line's source range, before it is classified. */
export interface SourceLine {
  start: number;
  end: number;
}
