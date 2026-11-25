/**
 * Read-mode layout of a list block: one row per source line, with a hanging
 * indent (#3252).
 *
 * A bullet, numbered or task line is drawn as a row of three cells -- its
 * indent, its marker column, and its text -- so a line that wraps starts every
 * later visual line on the text column, never back under the marker. The
 * marker is decoration, as it always was: the writer's own ``- `` / ``1. `` /
 * ``- [ ] `` stays hidden at its source offset, so every stored anchor keeps
 * addressing the same code points and an anchored run is still a nested
 * ``<Text>`` inside the line's text cell.
 *
 * The marker column has one width for every item of a block, so ``9.`` and
 * ``10.`` share a text column and a nested item's text always sits its indent
 * to the right of its parent's. Nothing is measured in script: each row's
 * column holds an unseen copy of every marker shape in the block (the
 * "sizers"), and the layout engine makes the column as wide as the widest of
 * them, in whatever face the body is set in. A row whose marker is the block's
 * only shape needs no copy and simply sits in the column.
 *
 * Shared by {@link HighlightedBody} (the entry reader) and
 * {@link ReadOnlyMarkdownText} (previews), so the two cannot drift. Not named
 * ``markdown*``: ``journalMarkdownPurity.test.ts`` reserves that prefix for
 * modules that import no React Native.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextProps, TextStyle } from 'react-native';

import {
  markdownRuns,
  type JournalMarkdownBlock,
  type JournalMarkdownDocument,
  type JournalMarkdownLine,
} from './journalMarkdown';

import { decorativeHidden } from '@/components/a11yHidden';
import { colors } from '@/design/tokens';

/**
 * The bullet glyph a list item renders.
 *
 * Renderer decoration, deliberately NOT a character in the source stream: the
 * writer's own marker stays at its source offset (hidden), so every anchor the
 * backend stores keeps addressing the same code points.
 */
const JOURNAL_BULLET_GLYPH = '• ';
/** One column of rendered list indent, matching the measured indent width. */
const JOURNAL_INDENT_COLUMN = ' ';

/**
 * The checkbox a task line draws in place of the writer's hidden ``- [ ] ``.
 * Decoration like the bullet glyph: never a character in the source stream.
 */
export const JOURNAL_TASK_GLYPHS = Object.freeze({ open: '☐', done: '☑' });

/** A native task glyph's transparent reach: at least 44dp without changing its ink. */
const TASK_HIT_SLOP = Object.freeze({ top: 12, right: 14, bottom: 12, left: 14 });

/** Kinds drawn as a list: one hanging-indent row per line. */
const LIST_BLOCK_KINDS: ReadonlySet<JournalMarkdownBlock['kind']> = new Set([
  'bullet',
  'ordered',
  'task',
]);

/** Whether a block is laid out by {@link renderListRows}. */
export function isListBlock(block: JournalMarkdownBlock): boolean {
  return LIST_BLOCK_KINDS.has(block.kind);
}

// Native Text forwards hitSlop even though the public TextProps declaration omits it.
interface TaskKeyEvent {
  key?: string;
  nativeEvent?: { key?: string };
  preventDefault: () => void;
  stopPropagation: () => void;
}

type TaskGlyphProps = TextProps & {
  hitSlop?: typeof TASK_HIT_SLOP;
  onKeyDown?: (_event: TaskKeyEvent) => void;
};
const TaskGlyph = Text as React.ComponentType<TaskGlyphProps>;

/** A read-mode task press, addressed by the source line's code-point start. */
export type TaskPress = (_lineStart: number) => void;

/** Keep feed/source task glyphs truly inert when there is no finished-page handler. */
function taskOnPress(onTaskPress: TaskPress | undefined, lineStart: number): TextProps['onPress'] {
  if (onTaskPress == null) return undefined;
  return (event) => {
    event?.stopPropagation();
    onTaskPress(lineStart);
  };
}

/** A span with checkbox semantics needs the native checkbox keyboard contract too. */
function taskOnKeyDown(
  onTaskPress: TaskPress | undefined,
  lineStart: number,
): TaskGlyphProps['onKeyDown'] {
  if (onTaskPress == null) return undefined;
  return (event) => {
    const key = event.key ?? event.nativeEvent?.key;
    if (key !== ' ' && key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    onTaskPress(lineStart);
  };
}

/** RN Web drops Text's checkbox state unless its ARIA spelling is explicit. */
function taskStateProps(interactive: boolean, checked: boolean): TextProps {
  if (!interactive) return {};
  const native = { accessibilityState: { checked } };
  if (Platform.OS !== 'web') return native;
  return { ...native, 'aria-checked': checked } as TextProps;
}

/** What a list line draws in its marker column, gap included. */
function listMarkerText(document: JournalMarkdownDocument, line: JournalMarkdownLine): string {
  if (line.kind === 'ordered') {
    // As typed (``3.`` / ``3)``). The separator after the delimiter may be a
    // tab; a space is drawn instead.
    return `${document.chars.slice(line.indentEnd, line.contentStart - 1).join('')} `;
  }
  if (line.kind !== 'task') return JOURNAL_BULLET_GLYPH;
  return `${line.taskChecked === true ? JOURNAL_TASK_GLYPHS.done : JOURNAL_TASK_GLYPHS.open} `;
}

/**
 * The shape of a marker, for sizing its column: every digit reads as ``0``, so
 * a hundred-item list has three shapes (``0. ``, ``00. ``, ``000. ``) rather
 * than a hundred. Tabular numerals make a shape exactly as wide as each marker
 * it stands for; where a face has none, the column is still one width for the
 * whole block, which is what keeps the text column true.
 */
function markerShape(marker: string): string {
  return marker.replaceAll(/\d/gu, '0');
}

/** The block's distinct marker shapes, in the order they first appear. */
function markerShapes(document: JournalMarkdownDocument, block: JournalMarkdownBlock): string[] {
  const shapes: string[] = [];
  for (const line of block.lines) {
    const shape = markerShape(listMarkerText(document, line));
    if (!shapes.includes(shape)) shapes.push(shape);
  }
  return shapes;
}

/** Everything the rows of one list block share. */
export interface ListBlockLayout {
  document: JournalMarkdownDocument;
  block: JournalMarkdownBlock;
  /** The body type every cell is set in; typography only, no box styles. */
  textStyle: StyleProp<TextStyle>;
  /** Finished-entry task glyphs become controls only when this is supplied. */
  onTaskPress?: TaskPress;
}

interface MarkerProps {
  layout: ListBlockLayout;
  line: JournalMarkdownLine;
  text: string;
  /** Lifted out of the flow onto the column's edge, when sizers hold its width. */
  placed: boolean;
}

/** A task line's glyph, plain in feeds and a checkbox on the finished page. */
function TaskMarker({ layout, line, text, placed }: MarkerProps): React.JSX.Element {
  const { document, textStyle, onTaskPress } = layout;
  const checked = line.taskChecked === true;
  const interactive = onTaskPress != null;
  const label = markdownRuns(document, line.contentStart, line.end)
    .map((run) => run.text)
    .join('')
    .trim();
  return (
    <TaskGlyph
      selectable={false}
      style={[
        textStyle,
        styles.taskGlyph,
        interactive && styles.taskTarget,
        placed && styles.placedStart,
      ]}
      onPress={taskOnPress(onTaskPress, line.start)}
      onKeyDown={taskOnKeyDown(onTaskPress, line.start)}
      accessibilityRole={interactive ? 'checkbox' : undefined}
      {...taskStateProps(interactive, checked)}
      accessibilityLabel={interactive ? label || 'Task item' : undefined}
      hitSlop={!interactive || Platform.OS === 'web' ? undefined : TASK_HIT_SLOP}
      testID={`journal-markdown-checkbox-${line.start}`}
    >
      {text}
    </TaskGlyph>
  );
}

/** The style a marker of this kind adds to the body type (its sizers wear it too). */
function markerStyle(kind: JournalMarkdownLine['kind']): TextStyle | null {
  if (kind === 'ordered') return styles.ordinal;
  return kind === 'task' ? styles.taskGlyph : null;
}

/** The visible marker of one row: a checkbox, the writer's number, or a bullet. */
function Marker(props: MarkerProps): React.JSX.Element {
  const { layout, line, text, placed } = props;
  if (line.kind === 'task') return <TaskMarker {...props} />;
  const ordered = line.kind === 'ordered';
  return (
    <Text
      selectable={false}
      style={[
        layout.textStyle,
        markerStyle(line.kind),
        placed && (ordered ? styles.placedEnd : styles.placedStart),
      ]}
      testID={`journal-markdown-${ordered ? 'ordinal' : 'marker'}-${line.start}`}
    >
      {text}
    </Text>
  );
}

/**
 * The marker column of one row: as wide as the widest marker shape in the
 * block, with the row's own marker on it.
 */
function MarkerColumn({
  layout,
  line,
  shapes,
}: {
  layout: ListBlockLayout;
  line: JournalMarkdownLine;
  shapes: readonly string[];
}): React.JSX.Element {
  const text = listMarkerText(layout.document, line);
  // The block's only shape, and exactly this marker: it sizes itself.
  const sizesItself = shapes.length === 1 && shapes[0] === text;
  return (
    <View
      style={[styles.markerColumn, layout.onTaskPress != null && styles.markerColumnRaised]}
      testID={`journal-markdown-item-marker-${line.start}`}
    >
      {sizesItself
        ? null
        : shapes.map((shape, index) => (
            <Text
              key={shape}
              {...decorativeHidden()}
              selectable={false}
              style={[
                layout.textStyle,
                markerStyle(line.kind),
                styles.sizer,
                index > 0 && styles.sizerStacked,
              ]}
            >
              {shape}
            </Text>
          ))}
      <Marker layout={layout} line={line} text={text} placed={!sizesItself} />
    </View>
  );
}

/** A checked task's text is dimmed, not struck: strikethrough is an inline style of its own. */
function itemContent(line: JournalMarkdownLine, content: React.ReactNode[]): React.ReactNode {
  if (line.kind !== 'task' || line.taskChecked !== true) return content;
  return (
    <Text style={styles.taskDone} testID={`journal-markdown-task-done-${line.start}`}>
      {content}
    </Text>
  );
}

/**
 * The rows of a list block, one per source line, in order.
 *
 * @param layout - The block and the type it is set in.
 * @param contentOf - The line's visible content (anchored runs included).
 */
export function renderListRows(
  layout: ListBlockLayout,
  contentOf: (_line: JournalMarkdownLine) => React.ReactNode[],
): React.ReactNode[] {
  const shapes = markerShapes(layout.document, layout.block);
  return layout.block.lines.map((line) => (
    <View key={line.start} style={styles.row} testID={`journal-markdown-item-${line.start}`}>
      {line.indentWidth > 0 ? (
        <Text selectable={false} style={layout.textStyle}>
          {JOURNAL_INDENT_COLUMN.repeat(line.indentWidth)}
        </Text>
      ) : null}
      <MarkerColumn layout={layout} line={line} shapes={shapes} />
      <Text
        style={[layout.textStyle, styles.itemText]}
        testID={`journal-markdown-item-text-${line.start}`}
      >
        {itemContent(line, contentOf(line))}
      </Text>
    </View>
  ));
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  /** Never squeezed by a long item; its width is its widest child's. */
  markerColumn: {
    flexShrink: 0,
    alignItems: 'flex-start',
  },
  /** Keeps a pressable glyph's padded reach above the text cell beside it. */
  markerColumnRaised: {
    zIndex: 1,
  },
  /** The wrapping cell: all the width the indent and marker leave. */
  itemText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  /** A marker shape drawn only for its width: no ink. */
  sizer: {
    color: 'transparent',
  },
  /** Every sizer after the first adds width but no second line of height. */
  sizerStacked: {
    height: 0,
    overflow: 'hidden',
  },
  placedStart: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  /** Numbers are right-aligned, so their delimiters and text column line up. */
  placedEnd: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  /** A task's checkbox glyph: soft ink, like the writer's own marker would be. */
  taskGlyph: {
    color: colors.paper.inkSoft,
  },
  /** Padding plus cancelling margins expands the web DOM box without moving its ink. */
  taskTarget: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: -14,
    marginVertical: -12,
  },
  /** The writer's own number, soft ink, tabular so the column holds. */
  ordinal: {
    color: colors.paper.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  taskDone: {
    color: colors.paper.inkSoft,
  },
});
