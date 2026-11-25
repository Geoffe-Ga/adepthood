/**
 * Read-only rendering of a journal-dialect Markdown body, one ``<Text>`` where
 * it can be.
 *
 * The inline run renderer (bold / italic / underline, with the
 * ``journal-markdown-<style>-<start>`` test IDs) lives here and is shared with
 * {@link HighlightedBody}, so bold is styled in exactly one read-mode place.
 * Unlike HighlightedBody this component draws no anchors, no notes and no
 * ``journal-body-read`` container, and it renders blocks FLAT: a heading keeps
 * its rung of the type ramp, but a quote block gets no rule or wash. Two blocks
 * cannot live inside a ``<Text>``: a horizontal rule (a hairline) and a list,
 * whose bullet, task and numbered lines are hanging-indent rows shared with the
 * entry reader (``JournalListBlock``). A body holding either is split around
 * them. That makes it the right surface for a sources feed or any
 * preview that must never show raw markers, and the wrong one for the entry
 * reader itself.
 *
 * Deliberately not named ``markdown*``: ``journalMarkdownPurity.test.ts``
 * reserves that prefix for modules that import no React Native.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextProps, TextStyle, ViewStyle } from 'react-native';

import { isListBlock, renderListRows } from './JournalListBlock';
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

/** One line of the flat rendering: a heading at its rung, any other line as its runs. */
function renderFlatLine(
  document: JournalMarkdownDocument,
  line: JournalMarkdownLine,
): React.ReactNode[] {
  const content = markdownRuns(document, line.start, line.end).map(renderMarkdownRun);
  if (line.headingLevel == null) return content;
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

/**
 * A run of prose lines (one ``<Text>``), or one of the two things that cannot
 * live inside a ``<Text>``: a rule's hairline and a list's hanging-indent rows.
 */
type FlatSegment =
  { rule: number } | { list: JournalMarkdownBlock } | { lines: JournalMarkdownLine[] };

/** Split the document at its rules and its lists. */
function flatSegments(document: JournalMarkdownDocument): FlatSegment[] {
  const segments: FlatSegment[] = [];
  for (const block of document.blocks) {
    if (block.kind === 'rule') {
      segments.push({ rule: block.start });
      continue;
    }
    if (isListBlock(block)) {
      segments.push({ list: block });
      continue;
    }
    const last = segments.at(-1);
    if (last != null && 'lines' in last) last.lines.push(...block.lines);
    else segments.push({ lines: [...block.lines] });
  }
  return segments;
}

/** Every line of a segment in order, line feeds restored only between them. */
function renderFlatLines(
  document: JournalMarkdownDocument,
  lines: JournalMarkdownLine[],
): React.ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index === 0 ? [] : ['\n']),
    ...renderFlatLine(document, line),
  ]);
}

/** Style keys that set type; every other key of a text style shapes its box. */
const TYPE_STYLE_KEYS: ReadonlySet<string> = new Set([
  'color',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textDecorationColor',
  'textDecorationLine',
  'textDecorationStyle',
  'textTransform',
]);

/**
 * Split a caller's text style into its type and its box.
 *
 * A body drawn as several elements cannot give each of them the caller's
 * padding or margin: the container takes the box once and every piece of text
 * inside it takes the type, so a list row is set exactly like a prose line.
 */
export function splitTextStyle(style: StyleProp<TextStyle>): { type: TextStyle; box: ViewStyle } {
  const type: Record<string, unknown> = {};
  const box: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(StyleSheet.flatten(style) ?? {})) {
    (TYPE_STYLE_KEYS.has(key) ? type : box)[key] = value;
  }
  return { type: type as TextStyle, box: box as ViewStyle };
}

/** One piece of a body that is drawn as several elements. */
function renderFlatSegment(
  document: JournalMarkdownDocument,
  segment: FlatSegment,
  type: TextStyle,
): React.JSX.Element {
  if ('rule' in segment) {
    return (
      <View
        key={`rule-${segment.rule}`}
        role="separator"
        style={styles.rule}
        testID={`journal-markdown-rule-${segment.rule}`}
      />
    );
  }
  if ('list' in segment) {
    const block = segment.list;
    return (
      <View key={`list-${block.start}`} accessibilityLabel="List">
        {renderListRows({ document, block, textStyle: type }, (line) =>
          markdownRuns(document, line.contentStart, line.end).map(renderMarkdownRun),
        )}
      </View>
    );
  }
  return (
    <Text key={`lines-${segment.lines[0]!.start}`} style={type}>
      {renderFlatLines(document, segment.lines)}
    </Text>
  );
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
  const { type, box } = splitTextStyle(style);
  return (
    <View style={box} testID={testID}>
      {segments.map((segment) => renderFlatSegment(document, segment, type))}
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
  rule: JOURNAL_RULE_STYLE,
});

export default ReadOnlyMarkdownText;
