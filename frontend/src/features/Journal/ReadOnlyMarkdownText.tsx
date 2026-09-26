/**
 * Read-only rendering of a journal-dialect Markdown body as one ``<Text>``.
 *
 * The inline run renderer (bold / italic / underline, with the
 * ``journal-markdown-<style>-<start>`` test IDs) lives here and is shared with
 * {@link HighlightedBody}, so bold is styled in exactly one read-mode place.
 * Unlike HighlightedBody this component draws no anchors, no notes and no
 * ``journal-body-read`` container, and it renders blocks FLAT: a bullet line
 * keeps its glyph, but a quote block gets no rule or wash. That makes it the
 * right surface for a sources feed or any preview that must never show raw
 * markers, and the wrong one for the entry reader itself.
 *
 * Deliberately not named ``markdown*``: ``journalMarkdownPurity.test.ts``
 * reserves that prefix for modules that import no React Native.
 */
import React from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';

import {
  markdownRuns,
  parseJournalMarkdown,
  type JournalMarkdownBlock,
  type JournalMarkdownDocument,
  type JournalMarkdownLine,
  type JournalMarkdownRun,
} from './journalMarkdown';

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

/** The indent and glyph a bullet line draws in front of its text. */
export function bulletDecoration(block: JournalMarkdownBlock, line: JournalMarkdownLine): string[] {
  if (block.kind !== 'bullet') return [];
  return [`${JOURNAL_INDENT_COLUMN.repeat(line.indentWidth)}${JOURNAL_BULLET_GLYPH}`];
}

/** Every line of every block in order, line feeds restored only between them. */
function renderFlatLines(document: JournalMarkdownDocument): React.ReactNode[] {
  return document.blocks
    .flatMap((block) => block.lines.map((line) => ({ block, line })))
    .flatMap(({ block, line }, index) => [
      ...(index === 0 ? [] : ['\n']),
      ...bulletDecoration(block, line),
      ...markdownRuns(document, line.start, line.end).map(renderMarkdownRun),
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
  return (
    <Text style={style} testID={testID}>
      {renderFlatLines(document)}
    </Text>
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
});

export default ReadOnlyMarkdownText;
