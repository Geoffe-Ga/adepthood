import { describe, expect, it } from '@jest/globals';

import { JOURNAL_TAB_COLUMNS } from '../journalMarkdown';
import type { MarkdownEdit } from '../markdownEditing';
import {
  DEFAULT_INDENT_UNIT,
  TAB_INDENT_UNIT,
  WIDE_INDENT_UNIT,
  inferIndentUnit,
  listLevelAt,
  outdentIndent,
  shiftListLines,
} from '../markdownIndent';

describe('the indent unit constants', () => {
  it('names two spaces, four spaces (one tab stop) and a tab', () => {
    expect(DEFAULT_INDENT_UNIT).toBe('  ');
    expect(WIDE_INDENT_UNIT).toBe(' '.repeat(JOURNAL_TAB_COLUMNS));
    expect(TAB_INDENT_UNIT).toBe('\t');
  });
});

describe('inferIndentUnit', () => {
  it.each([
    ['two-space nesting', '- a\n  - b\n    - c', DEFAULT_INDENT_UNIT],
    ['four-space nesting', '- a\n    - b\n        - c', WIDE_INDENT_UNIT],
    ['tab nesting', '- a\n\t- b\n\t\t- c', TAB_INDENT_UNIT],
    ['tabs and spaces mixed across lines', '- a\n\t- b\n    - c', DEFAULT_INDENT_UNIT],
    ['tabs and spaces mixed in one indent', '- a\n\t    - b', DEFAULT_INDENT_UNIT],
    ['a width that is not a whole tab stop', '- a\n      - b', DEFAULT_INDENT_UNIT],
    ['four and two spaces', '- a\n    - b\n  - c', DEFAULT_INDENT_UNIT],
    ['no indented item at all', '- a\n- b', DEFAULT_INDENT_UNIT],
    ['an empty body', '', DEFAULT_INDENT_UNIT],
  ])('reads %s as %j', (_label, body, unit) => {
    expect(inferIndentUnit(body)).toBe(unit);
  });

  it('reads list lines only, not indented prose or quotes', () => {
    expect(inferIndentUnit('\tprose\n  > quote\n- a\n    - b')).toBe(WIDE_INDENT_UNIT);
    expect(inferIndentUnit('    prose\n- a\n\t- b')).toBe(TAB_INDENT_UNIT);
  });

  it('counts a tab-separated marker as a list line', () => {
    expect(inferIndentUnit('-\ta\n\t-\tb')).toBe(TAB_INDENT_UNIT);
  });

  it('does not count a marker glued to its text as a list line', () => {
    expect(inferIndentUnit('    -glued\n- a')).toBe(DEFAULT_INDENT_UNIT);
  });
});

describe('outdentIndent', () => {
  it.each([
    ['    ', WIDE_INDENT_UNIT, ''],
    ['        ', WIDE_INDENT_UNIT, '    '],
    ['  ', DEFAULT_INDENT_UNIT, ''],
    ['\t\t', TAB_INDENT_UNIT, '\t'],
    ['\t  ', DEFAULT_INDENT_UNIT, '\t'],
    ['  \t', DEFAULT_INDENT_UNIT, '  '],
    ['   ', DEFAULT_INDENT_UNIT, ' '],
    [' ', DEFAULT_INDENT_UNIT, ''],
    ['\t  ', TAB_INDENT_UNIT, '\t'],
    ['      ', TAB_INDENT_UNIT, '  '],
  ])('steps %j back one %j level to %j, from the end nearest the marker', (indent, unit, out) => {
    expect(outdentIndent(indent, unit)).toBe(out);
  });

  it('returns null at level 0 rather than an unchanged indent', () => {
    expect(outdentIndent('', DEFAULT_INDENT_UNIT)).toBeNull();
  });
});

describe('shiftListLines -- the caret line', () => {
  it.each([
    ['at the content start', 6],
    ['mid-item', 7],
    ['at the end', 8],
  ])('indents the caret line %s, keeping the caret on the same character', (_label, caret) => {
    expect(shiftListLines('- a\n- bc', { start: caret, end: caret }, 'indent')).toEqual({
      text: '- a\n  - bc',
      selection: { start: caret + 2, end: caret + 2 },
    });
  });

  it('indents with the caret at the very start of the line, moving it with the text', () => {
    expect(shiftListLines('- a\n- b', { start: 4, end: 4 }, 'indent')).toEqual({
      text: '- a\n  - b',
      selection: { start: 6, end: 6 },
    });
  });

  it('adds the unit at the end of the indent, so outdent undoes it exactly', () => {
    const indented = shiftListLines('\t- a', { start: 3, end: 3 }, 'indent');
    expect(indented?.text).toBe('\t\t- a');
    expect(shiftListLines(indented!.text, indented!.selection!, 'outdent')?.text).toBe('\t- a');

    // A mixed indent shows where the unit goes: after the tab, not before it.
    const mixed = shiftListLines('- x\n  \t- a', { start: 10, end: 10 }, 'indent');
    expect(mixed).toEqual({ text: '- x\n  \t  - a', selection: { start: 12, end: 12 } });
    expect(shiftListLines(mixed!.text, mixed!.selection!, 'outdent')?.text).toBe('- x\n  \t- a');
  });

  it('outdents one level', () => {
    expect(shiftListLines('- a\n  - b', { start: 8, end: 8 }, 'outdent')).toEqual({
      text: '- a\n- b',
      selection: { start: 6, end: 6 },
    });
  });

  it('clamps a caret inside a removed indent to where the indent now ends', () => {
    // Two-space unit; the level nearest the marker is removed from [12, 14).
    expect(shiftListLines('- a\n  - b\n    - c', { start: 13, end: 13 }, 'outdent')).toEqual({
      text: '- a\n  - b\n  - c',
      selection: { start: 12, end: 12 },
    });
    expect(shiftListLines('- a\n  - b', { start: 5, end: 5 }, 'outdent')).toEqual({
      text: '- a\n- b',
      selection: { start: 4, end: 4 },
    });
  });

  it('returns null for outdent at level 0, so Shift+Tab can leave the field', () => {
    expect(shiftListLines('- a', { start: 3, end: 3 }, 'outdent')).toBeNull();
  });

  it.each(['indent', 'outdent'] as const)('returns null to %s a prose line', (direction) => {
    expect(shiftListLines('  prose', { start: 3, end: 3 }, direction)).toBeNull();
    expect(shiftListLines('  > quote', { start: 5, end: 5 }, direction)).toBeNull();
  });

  it('enforces no maximum depth', () => {
    // The two-space sibling pins the document's unit, so every press adds one level.
    const anchor = '- top\n  - anchor\n';
    let edit: MarkdownEdit = { text: `${anchor}- deep`, selection: { start: 23, end: 23 } };
    for (let level = 1; level <= 10; level += 1) {
      edit = shiftListLines(edit.text, edit.selection!, 'indent')!;
    }
    expect(edit).toEqual({
      text: `${anchor}${'  '.repeat(10)}- deep`,
      selection: { start: 43, end: 43 },
    });
  });

  it('keeps the typed marker', () => {
    expect(shiftListLines('+ a\n* b', { start: 7, end: 7 }, 'indent')?.text).toBe('+ a\n  * b');
  });
});

describe('shiftListLines -- a selection across lines', () => {
  const BODY = 'Intro\n- one\n- two\nprose\n- three';

  it('moves every selected list line and leaves prose untouched', () => {
    // From inside "one" to inside "three".
    expect(shiftListLines(BODY, { start: 8, end: 28 }, 'indent')).toEqual({
      text: 'Intro\n  - one\n  - two\nprose\n  - three',
      selection: { start: 10, end: 34 },
    });
  });

  it('does not touch a line the selection only reaches the start of', () => {
    // Ends exactly at the start of "- two".
    expect(shiftListLines(BODY, { start: 8, end: 12 }, 'indent')).toEqual({
      text: 'Intro\n  - one\n- two\nprose\n- three',
      selection: { start: 10, end: 14 },
    });
  });

  it('outdents the lines that can move and leaves level-0 lines as they are', () => {
    expect(shiftListLines('- a\n  - b\n- c', { start: 0, end: 13 }, 'outdent')).toEqual({
      text: '- a\n- b\n- c',
      selection: { start: 0, end: 11 },
    });
  });

  it('returns null for outdent when every selected list line is at level 0', () => {
    expect(shiftListLines('- a\nprose\n- c', { start: 0, end: 13 }, 'outdent')).toBeNull();
  });

  it('keeps UTF-16 selections exact around astral characters', () => {
    const body = '\u{1F600} x\n- a\u{1F600}\n- b';
    // UTF-16: the emoji is 2 units; "- a😀" starts at 5, "- b" at 11.
    const edit = shiftListLines(body, { start: 1 + 1, end: 12 }, 'indent');
    expect(edit?.text).toBe('\u{1F600} x\n  - a\u{1F600}\n  - b');
    expect(edit?.selection).toEqual({ start: 2, end: 16 });
    const back = shiftListLines(edit!.text, { start: 8, end: 8 }, 'outdent');
    expect(back?.text).toBe('\u{1F600} x\n- a\u{1F600}\n  - b');
    expect(back?.selection).toEqual({ start: 6, end: 6 });
  });
});

describe('listLevelAt', () => {
  it.each([
    ['- a', 1, 0],
    ['  - a', 3, 1],
    ['- a\n    - b\n        - c', 20, 2],
    ['\t\t- a', 4, 2],
    // A partial indent still counts as nested: outdent can remove it.
    [' - a', 2, 1],
    ['- a\n   - b', 8, 2],
  ])('reads %j at %i as level %i', (body, caret, level) => {
    expect(listLevelAt(body, caret)).toBe(level);
  });

  it.each([
    ['prose', 2],
    ['> quote', 3],
    ['-glued', 2],
  ])('is null off a list line: %j', (body, caret) => {
    expect(listLevelAt(body, caret)).toBeNull();
  });
});
