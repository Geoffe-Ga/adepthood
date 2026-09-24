/**
 * The styled mirror drawn in register with the body's real ``<textarea>`` on
 * web -- laid over it with pointer events off, so every click, drag and tap
 * still lands on the textarea.
 *
 * The textarea keeps the exact source, the caret, selection, undo, paste and
 * the screen reader; its glyphs are transparent. This draws the same
 * characters in the same place with the Markdown styled: content from the
 * shared model (so it matches read mode), prefixes and delimiters dimmed
 * rather than removed, and the delimiters around the caret revealed.
 *
 * Hidden from assistive technology: the textarea already announces the body,
 * and announcing it twice would make the page unusable with a screen reader.
 */
import React, { useMemo } from 'react';
import { Text, View, type TextStyle } from 'react-native';

import { parseJournalMarkdown, type SourceSelection } from './journalMarkdown';
import liveStyles from './LiveMarkdownStyles';
import { buildMirrorModel, type MirrorLine, type MirrorRun } from './markdownMirror';

/** Content run: nested styled Text, one per style, each tagged by its source start. */
function ContentRun({ run }: { run: MirrorRun }): React.ReactNode {
  let node: React.ReactNode = run.text;
  const layers: [boolean, 'italic' | 'underline' | 'bold', TextStyle][] = [
    [run.italic, 'italic', liveStyles.italic],
    [run.underline, 'underline', liveStyles.underline],
    [run.bold, 'bold', liveStyles.bold],
  ];
  for (const [applies, style, textStyle] of layers) {
    if (!applies) continue;
    node = (
      <Text style={textStyle} testID={`journal-live-${style}-${run.start}`}>
        {node}
      </Text>
    );
  }
  return node;
}

function MirrorRunText({ run }: { run: MirrorRun }): React.ReactNode {
  if (run.role === 'content') return <ContentRun run={run} />;
  return (
    <Text
      style={run.revealed ? liveStyles.revealed : liveStyles.dimmed}
      testID={`journal-live-${run.role}-${run.start}`}
    >
      {run.text}
    </Text>
  );
}

function MirrorLineText({ line }: { line: MirrorLine }): React.JSX.Element {
  const runs = line.runs.map((run) => <MirrorRunText key={run.start} run={run} />);
  if (line.kind === 'quote') {
    return (
      <Text style={liveStyles.quoteLine} testID={`journal-live-quote-${line.start}`}>
        {runs}
      </Text>
    );
  }
  return <Text testID={`journal-live-${line.kind}-${line.start}`}>{runs}</Text>;
}

export interface LiveMarkdownMirrorProps {
  body: string;
  /** The field's selection in SOURCE positions (code points), for delimiter reveal. */
  selection: SourceSelection;
  /** Extra text style the field also carries (web tab stops). */
  textStyle?: TextStyle;
}

export default function LiveMarkdownMirror({
  body,
  selection,
  textStyle,
}: LiveMarkdownMirrorProps): React.JSX.Element {
  const document = useMemo(() => parseJournalMarkdown(body), [body]);
  const { start, end } = selection;
  const lines = useMemo(() => buildMirrorModel(document, { start, end }), [document, start, end]);
  return (
    <View
      testID="journal-body-mirror"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={liveStyles.mirror}
    >
      <Text style={[liveStyles.mirrorText, textStyle]}>
        {lines.map((line, index) => (
          <React.Fragment key={line.start}>
            {index > 0 ? '\n' : null}
            <MirrorLineText line={line} />
          </React.Fragment>
        ))}
      </Text>
    </View>
  );
}
