/**
 * What the live editor's mirror draws behind the real text field -- pure data.
 *
 * The mirror sits under a ``<textarea>`` whose own glyphs are transparent, so
 * it has to lay out EXACTLY the characters the textarea does: every block
 * prefix and every emphasis delimiter stays in the run stream with its own
 * advance, dimmed rather than removed. Removing one would slide every later
 * glyph out from under the caret.
 *
 * Its styled content, on the other hand, must be exactly what read mode
 * renders (``markdownRuns``), so edit mode and read mode cannot disagree about
 * which text is bold. Both come from the one parsed document.
 */
import {
  revealedDelimiters,
  type JournalMarkdownDocument,
  type JournalMarkdownRun,
  type LineKind,
  type SourceLine,
  type SourceSelection,
} from './journalMarkdown';

/**
 * Why a character is in the mirror: a bullet's indent, a block marker (``- ``
 * or ``> ``), an emphasis delimiter, or the writer's content.
 */
export type MirrorRunRole = 'indent' | 'marker' | 'delimiter' | 'content';

/** A stretch of source characters the mirror draws the same way. */
export interface MirrorRun {
  start: number;
  end: number;
  text: string;
  role: MirrorRunRole;
  /** A delimiter the selection reveals at full ink instead of dimmed. */
  revealed: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/** One source line of the mirror. */
export interface MirrorLine {
  start: number;
  end: number;
  kind: LineKind;
  /** Indent measured in columns (tabs count ``JOURNAL_TAB_COLUMNS``), as read mode draws it. */
  indentWidth: number;
  runs: MirrorRun[];
}

type CharacterKey = Omit<MirrorRun, 'start' | 'end' | 'text'>;

function roleAt(
  document: JournalMarkdownDocument,
  line: { kind: LineKind; indentEnd: number; contentStart: number },
  index: number,
): MirrorRunRole {
  if (line.kind !== 'plain' && index < line.contentStart) {
    return index < line.indentEnd ? 'indent' : 'marker';
  }
  return document.formats[index]!.visible ? 'content' : 'delimiter';
}

function isRevealed(ranges: SourceLine[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function sameKey(a: CharacterKey, b: CharacterKey): boolean {
  return (
    a.role === b.role &&
    a.revealed === b.revealed &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

/**
 * Lay out a parsed document for the mirror, revealing the delimiters the
 * selection (in source positions) is inside.
 */
export function buildMirrorModel(
  document: JournalMarkdownDocument,
  selection: SourceSelection,
): MirrorLine[] {
  const revealed = revealedDelimiters(document, selection);
  return document.blocks.flatMap((block) =>
    block.lines.map((line) => {
      const runs: MirrorRun[] = [];
      for (let index = line.start; index < line.end; index += 1) {
        const role = roleAt(document, line, index);
        const format = document.formats[index]!;
        const key: CharacterKey = {
          role,
          revealed: role === 'delimiter' && isRevealed(revealed, index),
          bold: role === 'content' && format.bold,
          italic: role === 'content' && format.italic,
          underline: role === 'content' && format.underline,
        };
        const last = runs.at(-1);
        if (last != null && sameKey(last, key)) {
          last.end = index + 1;
          last.text += document.chars[index];
        } else {
          runs.push({ ...key, start: index, end: index + 1, text: document.chars[index]! });
        }
      }
      return {
        start: line.start,
        end: line.end,
        kind: line.kind,
        indentWidth: line.indentWidth,
        runs,
      };
    }),
  );
}

/** The styled content of one mirror line, in read mode's own run shape. */
export function visibleMirrorRuns(line: MirrorLine): JournalMarkdownRun[] {
  return line.runs
    .filter((run) => run.role === 'content')
    .map(({ start, end, text, bold, italic, underline }) => ({
      start,
      end,
      text,
      visible: true,
      bold,
      italic,
      underline,
    }));
}
