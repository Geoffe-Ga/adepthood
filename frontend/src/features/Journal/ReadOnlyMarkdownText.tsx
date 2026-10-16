/**
 * Read-only rendering of a journal-dialect Markdown body as one ``<Text>``.
 *
 * The inline run renderer (bold / italic / underline, with the
 * ``journal-markdown-<style>-<start>`` test IDs) lives here and is shared with
 * {@link HighlightedBody}, so bold is styled in exactly one read-mode place.
 * Unlike HighlightedBody this component draws no anchors, no notes and no
 * ``journal-body-read`` container, and it renders blocks FLAT: a bullet, task
 * or ordered line keeps its glyph or number and a heading its rung of the type
 * ramp, but a quote block gets no rule or wash. A horizontal rule is the one
 * block that cannot live inside a ``<Text>``, so a body holding one is split
 * around a hairline. That makes it the right surface for a sources feed or any
 * preview that must never show raw markers, and the wrong one for the entry
 * reader itself.
 *
 * Deliberately not named ``markdown*``: ``journalMarkdownPurity.test.ts``
 * reserves that prefix for modules that import no React Native.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextProps, TextStyle, ViewStyle } from 'react-native';

import {
  markdownRuns,
  parseJournalMarkdown,
  type JournalMarkdownBlock,
  type JournalMarkdownDocument,
  type JournalMarkdownLine,
  type JournalMarkdownRun,
} from './journalMarkdown';

import { SPACING, colors, editorialType } from '@/design/tokens';

/**
 * The bullet glyph a list item renders.
 *
 * Renderer decoration, deliberately NOT a character in the source stream: the
 * writer's own marker stays at its source offset (hidden), so every anchor the
 * backend stores keeps addressing the same code points.
 */
export const JOURNAL_BULLET_GLYPH = '• ';
/** One column of rendered bullet indent, matching the measured indent width. */
export const JOURNAL_INDENT_COLUMN = ' ';

/**
 * The checkbox a task line draws in place of the writer's hidden ``- [ ] ``.
 * Decoration like the bullet glyph: never a character in the source stream.
 */
export const JOURNAL_TASK_GLYPHS = Object.freeze({ open: '\u2610', done: '\u2611' });

/**
 * Pads an ordered marker to {@link ORDINAL_COLUMN_DIGITS} digits. A figure
 * space is exactly one tabular digit wide, so with tabular numerals ``9.`` and
 * ``10.`` share a text edge.
 */
export const JOURNAL_ORDINAL_PAD = '\u2007';
/** The digit column an ordered marker is right-aligned to. */
export const ORDINAL_COLUMN_DIGITS = 2;
/**
 * The hairline a horizontal rule draws in read mode (its characters stay hidden
 * in the source): the faint warm rule, with breathing room above and below.
 */
export const JOURNAL_RULE_STYLE: ViewStyle = Object.freeze({
  height: StyleSheet.hairlineWidth,
  backgroundColor: colors.paper.hairline,
  marginVertical: SPACING.sm,
});
/** Heading levels that take their own rung; deeper levels share H3's. */
const HEADING_RUNG_LEVELS = 3;

/** Semantic roles become matching HTML elements on web; native uses the style. */
export function webRole(role: 'strong' | 'emphasis' | 'blockquote'): never | undefined {
  return Platform.OS === 'web' ? (role as never) : undefined;
}

/** Render one visible inline run, composing bold + italic when both apply. */
export function renderMarkdownRun(run: JournalMarkdownRun): React.ReactNode {
  let node: React.ReactNode = run.text;
  if (run.italic) {
    node = (
      <Text
        key={`italic-${run.start}`}
        role={webRole('emphasis')}
        style={styles.italic}
        testID={`journal-markdown-italic-${run.start}`}
      >
        {node}
      </Text>
    );
  }
  if (run.underline) {
    node = (
      <Text
        key={`underline-${run.start}`}
        style={styles.underline}
        testID={`journal-markdown-underline-${run.start}`}
      >
        {node}
      </Text>
    );
  }
  if (run.bold) {
    node = (
      <Text
        key={`bold-${run.start}`}
        role={webRole('strong')}
        style={styles.bold}
        testID={`journal-markdown-bold-${run.start}`}
      >
        {node}
      </Text>
    );
  }
  return node;
}

/** The rung of the read-mode type ramp a heading of ``level`` is drawn at. */
export function headingStyle(level: number): TextStyle {
  const rungs = [styles.heading1, styles.heading2, styles.heading3];
  return rungs[Math.min(level, HEADING_RUNG_LEVELS) - 1]!;
}

/**
 * A heading's semantics: ``role="heading"`` with its ``aria-level`` on web
 * (react-native-web renders the matching ``<h1>``-``<h6>``), the header role on
 * native. ``aria-level`` is a react-native-web prop absent from RN's TextProps.
 */
export function headingProps(level: number): TextProps {
  if (Platform.OS !== 'web') return { accessibilityRole: 'header' };
  return { role: 'heading', 'aria-level': level } as TextProps;
}

/** The indent a list line draws, one column per measured indent column. */
function indentOf(line: JournalMarkdownLine): string {
  return JOURNAL_INDENT_COLUMN.repeat(line.indentWidth);
}

/** The ordered marker exactly as typed (``3.`` / ``3)``), padded to the digit column. */
function ordinalText(document: JournalMarkdownDocument, line: JournalMarkdownLine): string {
  // The separator after the delimiter may be a tab; a space is drawn instead.
  const typed = document.chars.slice(line.indentEnd, line.contentStart - 1);
  const pad = JOURNAL_ORDINAL_PAD.repeat(Math.max(0, ORDINAL_COLUMN_DIGITS + 1 - typed.length));
  return `${pad}${typed.join('')} `;
}

/** What a list line draws in front of its text: indent plus glyph, checkbox or number. */
export function lineDecoration(
  document: JournalMarkdownDocument,
  block: JournalMarkdownBlock,
  line: JournalMarkdownLine,
): React.ReactNode[] {
  if (block.kind === 'bullet') return [`${indentOf(line)}${JOURNAL_BULLET_GLYPH}`];
  if (block.kind === 'task') {
    const glyph = line.taskChecked === true ? JOURNAL_TASK_GLYPHS.done : JOURNAL_TASK_GLYPHS.open;
    return [
      indentOf(line),
      <Text
        key={`checkbox-${line.start}`}
        style={styles.marker}
        testID={`journal-markdown-checkbox-${line.start}`}
      >
        {`${glyph} `}
      </Text>,
    ];
  }
  if (block.kind === 'ordered') {
    return [
      indentOf(line),
      <Text
        key={`ordinal-${line.start}`}
        style={styles.ordinal}
        testID={`journal-markdown-ordinal-${line.start}`}
      >
        {ordinalText(document, line)}
      </Text>,
    ];
  }
  return [];
}

/**
 * One line's decoration followed by its content. A checked task's text is
 * dimmed, not struck: strikethrough is an inline style of its own.
 */
export function renderDecoratedLine(
  document: JournalMarkdownDocument,
  block: JournalMarkdownBlock,
  line: JournalMarkdownLine,
  content: React.ReactNode[],
): React.ReactNode[] {
  const decoration = lineDecoration(document, block, line);
  if (line.kind !== 'task' || line.taskChecked !== true) return [...decoration, ...content];
  return [
    ...decoration,
    <Text
      key={`task-done-${line.start}`}
      style={styles.taskDone}
      testID={`journal-markdown-task-done-${line.start}`}
    >
      {content}
    </Text>,
  ];
}

/** One line of the flat rendering: a heading at its rung, any other line decorated. */
function renderFlatLine(
  document: JournalMarkdownDocument,
  block: JournalMarkdownBlock,
  line: JournalMarkdownLine,
): React.ReactNode[] {
  const content = markdownRuns(document, line.start, line.end).map(renderMarkdownRun);
  if (line.headingLevel == null) return renderDecoratedLine(document, block, line, content);
  return [
    <Text
      key={`heading-${line.start}`}
      {...headingProps(line.headingLevel)}
      style={headingStyle(line.headingLevel)}
      testID={`journal-markdown-heading-${line.start}`}
    >
      {content}
    </Text>,
  ];
}

/** A run of non-rule lines, or the rule that separates two of them. */
type FlatSegment =
  { rule: number } | { lines: { block: JournalMarkdownBlock; line: JournalMarkdownLine }[] };

/** Split the document at its rules, which cannot be drawn inside a ``<Text>``. */
function flatSegments(document: JournalMarkdownDocument): FlatSegment[] {
  const segments: FlatSegment[] = [];
  for (const block of document.blocks) {
    if (block.kind === 'rule') {
      segments.push({ rule: block.start });
      continue;
    }
    const last = segments.at(-1);
    const lines = block.lines.map((line) => ({ block, line }));
    if (last != null && 'lines' in last) last.lines.push(...lines);
    else segments.push({ lines });
  }
  return segments;
}

/** Every line of a segment in order, line feeds restored only between them. */
function renderFlatLines(
  document: JournalMarkdownDocument,
  lines: { block: JournalMarkdownBlock; line: JournalMarkdownLine }[],
): React.ReactNode[] {
  return lines.flatMap(({ block, line }, index) => [
    ...(index === 0 ? [] : ['\n']),
    ...renderFlatLine(document, block, line),
  ]);
}

export interface ReadOnlyMarkdownTextProps {
  /** The raw journal-dialect body; markers are hidden at render time, never rewritten. */
  body: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

function ReadOnlyMarkdownText({
  body,
  style,
  testID,
}: ReadOnlyMarkdownTextProps): React.JSX.Element {
  const document = React.useMemo(() => parseJournalMarkdown(body), [body]);
  const segments = flatSegments(document);
  const [only] = segments;
  if (segments.length === 1 && only != null && 'lines' in only) {
    return (
      <Text style={style} testID={testID}>
        {renderFlatLines(document, only.lines)}
      </Text>
    );
  }
  return (
    <View testID={testID}>
      {segments.map((segment) =>
        'rule' in segment ? (
          <View
            key={`rule-${segment.rule}`}
            role="separator"
            style={styles.rule}
            testID={`journal-markdown-rule-${segment.rule}`}
          />
        ) : (
          <Text key={`lines-${segment.lines[0]!.line.start}`} style={style}>
            {renderFlatLines(document, segment.lines)}
          </Text>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  underline: {
    textDecorationLine: 'underline',
  },
  heading1: {
    ...editorialType.title,
  },
  heading2: {
    ...editorialType.heading,
  },
  heading3: {
    fontSize: editorialType.body.fontSize,
    lineHeight: editorialType.body.lineHeight,
    fontWeight: '700',
  },
  /** A task's checkbox glyph: soft ink, like the writer's own marker would be. */
  marker: {
    color: colors.paper.inkSoft,
  },
  /** The writer's own number, soft ink, tabular so the column holds. */
  ordinal: {
    color: colors.paper.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  taskDone: {
    color: colors.paper.inkSoft,
  },
  rule: JOURNAL_RULE_STYLE,
});

export default ReadOnlyMarkdownText;
