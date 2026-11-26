import { describe, expect, it } from '@jest/globals';

import { parseJournalMarkdown, serializeJournalMarkdown } from '../journalMarkdown';
import { classifyLines } from '../journalMarkdownLines';
import { continuationIndent } from '../markdownContinuation';
import {
  continueMarkdownEdit,
  deleteBackwardEdit,
  reconcileBodyChange,
  type MarkdownEdit,
} from '../markdownEditing';
import { listLevelAt, shiftListLines } from '../markdownIndent';
import { buildMirrorModel } from '../markdownMirror';

const SHIFT_RETURN = { key: 'Enter', shiftKey: true };
const RETURN = { key: 'Enter', shiftKey: false };

/** The classified kinds of a body's lines, in order. */
function kinds(body: string): string[] {
  return classifyLines(Array.from(body)).map((line) => line.kind);
}

/** Type a line feed at ``caret`` the way the field reports it, with the key that made it. */
function press(body: string, caret: number, key: { key: string; shiftKey: boolean }): MarkdownEdit {
  const next = `${body.slice(0, caret)}\n${body.slice(caret)}`;
  return reconcileBodyChange(body, next, { start: caret, end: caret }, key);
}

/** An edit's text with ``|`` drawn at its collapsed caret. */
function drawn(edit: MarkdownEdit): string {
  const caret = edit.selection?.start ?? edit.text.length;
  return `${edit.text.slice(0, caret)}|${edit.text.slice(caret)}`;
}

describe('classifyLines -- the continuation rule', () => {
  it.each([
    ['a bullet', '- buy oats\n  the steel-cut kind'],
    ['a numbered item', '10. buy oats\n    the steel-cut kind'],
    ['a checkbox', '- [ ] buy oats\n      the steel-cut kind'],
    ['a nested item', '- a\n  - b\n    under b'],
  ])('reads an unmarked line at the text column of %s as its continuation', (_name, body) => {
    const lines = classifyLines(Array.from(body));
    const line = lines.at(-1)!;
    expect(line.kind).toBe('continuation');
    expect(line.owner).toBe(lines.at(-2));
    expect(line.contentStart).toBe(line.indentEnd);
    expect(line.marker).toBeNull();
  });

  it('chains every following line at the column onto the same item', () => {
    const lines = classifyLines(Array.from('1. a\n   b\n   c\n2. d'));
    expect(lines.map((line) => line.kind)).toEqual([
      'ordered',
      'continuation',
      'continuation',
      'ordered',
    ]);
    expect(lines[2]!.owner).toBe(lines[0]);
    expect(lines[3]!.owner).toBeNull();
  });

  it('accepts a line indented past the column', () => {
    expect(kinds('- a\n      deeper')).toEqual(['bullet', 'continuation']);
  });

  it('counts the line Shift+Return just opened, which holds only its indent', () => {
    expect(kinds('- a\n  ')).toEqual(['bullet', 'continuation']);
  });

  it.each([
    ['a nested item', '- a\n  - b', ['bullet', 'bullet']],
    ['a nested numbered item', '- a\n  1. b', ['bullet', 'ordered']],
    ['a nested checkbox', '1. a\n   - [ ] b', ['ordered', 'task']],
    ['a line short of the text column', '1. a\n  b', ['ordered', 'plain']],
    ['a checkbox line short of its column', '- [ ] a\n  b', ['task', 'plain']],
    ['a flush line', '- a\nb', ['bullet', 'plain']],
    ['an empty line', '- a\n', ['bullet', 'plain']],
    ['a line after a blank one', '- a\n\n  b', ['bullet', 'plain', 'plain']],
    ['a line after prose', 'a\n  b', ['plain', 'plain']],
    ['a line after a quote', '> a\n  b', ['quote', 'plain']],
    ['an indented rule', '- a\n  ---', ['bullet', 'rule']],
    ['an indented heading', '- a\n  # b', ['bullet', 'heading']],
    ['a tab-separated marker', '- a\n  -\tb', ['bullet', 'plain']],
  ])('does not read %s as a continuation', (_name, body, expected) => {
    expect(kinds(body)).toEqual(expected);
  });

  it('keeps a marker glued to its text as continuation prose', () => {
    expect(kinds('- a\n  -5 degrees\n  >so cold')).toEqual([
      'bullet',
      'continuation',
      'continuation',
    ]);
  });

  it('measures a tab indent in columns against the item', () => {
    expect(kinds('\t- a\n\t  b')).toEqual(['bullet', 'continuation']);
    expect(kinds('\t- a\n  b')).toEqual(['bullet', 'plain']);
  });
});

describe('the parsed document with continuation lines', () => {
  it('keeps a continuation line in its item’s block and hides only its indent', () => {
    const body = '- a\n  b\n- c\nprose';
    const document = parseJournalMarkdown(body);
    expect(document.blocks.map((block) => [block.kind, block.lines.length])).toEqual([
      ['bullet', 3],
      ['plain', 1],
    ]);
    expect(document.formats.map((format) => (format.visible ? '1' : '0')).join('')).toBe(
      '001' + '1' + '001' + '1' + '001' + '1' + '11111',
    );
    expect(serializeJournalMarkdown(document)).toBe(body);
  });

  it('does not count a continuation indent as a nesting width', () => {
    expect(parseJournalMarkdown('- [ ] a\n      b').indentWidths).toEqual([]);
  });

  it('draws the continuation indent as an indent run in the live mirror', () => {
    const lines = buildMirrorModel(parseJournalMarkdown('1. a\n   **b**'), { start: 0, end: 0 });
    expect(lines[1]).toMatchObject({ kind: 'continuation', indentWidth: 3 });
    expect(lines[1]!.runs.map((run) => [run.text, run.role])).toEqual([
      ['   ', 'indent'],
      ['**', 'delimiter'],
      ['b', 'content'],
      ['**', 'delimiter'],
    ]);
  });
});

describe('continuationIndent', () => {
  it.each([
    ['- a', '  '],
    ['10. a', '    '],
    ['1) a', '   '],
    ['- [ ] a', '      '],
    ['- [x] a', '      '],
    ['  * a', '    '],
    ['\t- a', '\t  '],
  ])('pads %j to its text column with spaces after its own indent', (item, indent) => {
    const chars = Array.from(item);
    const [line] = classifyLines(chars);
    expect(continuationIndent(chars, line!)).toBe(indent);
  });
});

describe('Shift+Return', () => {
  it.each([
    ['- buy oats', '- buy oats\n  |'],
    ['1. buy oats', '1. buy oats\n   |'],
    ['10. buy oats', '10. buy oats\n    |'],
    ['- [ ] buy oats', '- [ ] buy oats\n      |'],
    ['- [x] buy oats', '- [x] buy oats\n      |'],
    ['  - nested', '  - nested\n    |'],
    ['\t1. tabbed', '\t1. tabbed\n\t   |'],
  ])('on %j opens a line under the item’s text, with no marker', (body, expected) => {
    expect(drawn(press(body, body.length, SHIFT_RETURN))).toBe(expected);
  });

  it('carries the text after the caret onto the continuation line', () => {
    expect(drawn(press('- buy oats', 6, SHIFT_RETURN))).toBe('- buy \n  |oats');
  });

  it('on a continuation line opens another at the item’s column', () => {
    const body = '1. buy oats\n   the kind';
    expect(drawn(press(body, body.length, SHIFT_RETURN))).toBe('1. buy oats\n   the kind\n   |');
  });

  it('realigns to the item even when the continuation line was indented further', () => {
    const body = '- a\n      b';
    expect(drawn(press(body, body.length, SHIFT_RETURN))).toBe('- a\n      b\n  |');
  });

  it.each([
    ['prose', 'buy oats'],
    ['a quote', '> buy oats'],
    ['a heading', '## buy oats'],
    ['a tab-separated marker the renderer draws as prose', '-\tbuy oats'],
  ])('on %s is left to the field as a plain line feed', (_name, body) => {
    expect(press(body, body.length, SHIFT_RETURN)).toEqual({ text: `${body}\n` });
  });

  it('inside an item’s marker is left to the field', () => {
    expect(press('- [ ] a', 3, SHIFT_RETURN)).toEqual({ text: '- [\n ] a' });
    expect(press('  - a', 0, SHIFT_RETURN)).toEqual({ text: '\n  - a' });
  });

  it('is unchanged Return where the field does not report Shift', () => {
    const next = '- a\n';
    expect(reconcileBodyChange('- a', next, { start: 3, end: 3 }, { key: 'Enter' })).toEqual({
      text: '- a\n- ',
      selection: { start: 6, end: 6 },
    });
    expect(reconcileBodyChange('- a', next, { start: 3, end: 3 })).toEqual({
      text: '- a\n- ',
      selection: { start: 6, end: 6 },
    });
  });

  it('never rewrites a line feed that Shift with another key produced', () => {
    const edit = reconcileBodyChange(
      '- a',
      '- a\n',
      { start: 3, end: 3 },
      { key: 'Insert', shiftKey: true },
    );
    expect(edit.text).toBe('- a\n- ');
  });

  it('counts the caret in UTF-16 past an astral character', () => {
    const body = '- \u{1F600} oats';
    const edit = press(body, body.length, SHIFT_RETURN);
    expect(edit.text).toBe(`${body}\n  `);
    expect(edit.selection).toEqual({ start: body.length + 3, end: body.length + 3 });
  });
});

describe('Return on a continuation line', () => {
  it.each([
    ['- buy oats\n  the kind', '- buy oats\n  the kind\n- |'],
    ['* buy oats\n  the kind', '* buy oats\n  the kind\n* |'],
    ['1. buy oats\n   the kind', '1. buy oats\n   the kind\n2. |'],
    ['9) buy oats\n   the kind', '9) buy oats\n   the kind\n10) |'],
    ['- [x] buy oats\n      the kind', '- [x] buy oats\n      the kind\n- [ ] |'],
    ['  - buy oats\n    the kind', '  - buy oats\n    the kind\n  - |'],
  ])('with content starts the next item of the owning kind for %j', (body, expected) => {
    expect(drawn(press(body, body.length, RETURN))).toBe(expected);
  });

  it('counts the numbered items below on from the new one', () => {
    const body = '1. a\n   more\n2. b\n3. c';
    expect(drawn(press(body, '1. a\n   more'.length, RETURN))).toBe(
      '1. a\n   more\n2. |\n3. b\n4. c',
    );
  });

  it('splits the line at a caret in its text', () => {
    expect(drawn(press('- a\n  bc', 7, RETURN))).toBe('- a\n  b\n- |c');
  });

  it.each([
    ['- a\n  ', '- a\n- |'],
    ['1. a\n   ', '1. a\n2. |'],
    ['- [ ] a\n      ', '- [ ] a\n- [ ] |'],
    ['1. a\n   b\n   ', '1. a\n   b\n2. |'],
  ])('on an empty one turns it into the next item: %j', (body, expected) => {
    expect(drawn(press(body, body.length, RETURN))).toBe(expected);
  });

  it('renumbers below an empty continuation line it turns into an item', () => {
    expect(drawn(press('1. a\n   \n2. b', 8, RETURN))).toBe('1. a\n2. |\n3. b');
  });

  it('before the line’s text turns the whole line into the next item', () => {
    expect(drawn(press('- a\n  b', 5, RETURN))).toBe('- a\n- |b');
  });

  it('then exits the list from the empty item, as before', () => {
    const body = '1. a\n   b\n2. ';
    expect(drawn(press(body, body.length, RETURN))).toBe('1. a\n   b\n|');
  });

  it('continues without the key when the field reports none', () => {
    const body = '- a\n  b';
    expect(continueMarkdownEdit(body, `${body}\n`, { start: 7, end: 7 })).toEqual({
      text: '- a\n  b\n- ',
      selection: { start: 10, end: 10 },
    });
  });
});

describe('Backspace on a continuation line', () => {
  it('at its content start removes the indent and joins the line above', () => {
    expect(deleteBackwardEdit('- a\n  b', { start: 6, end: 6 })).toEqual({
      text: '- ab',
      selection: { start: 3, end: 3 },
    });
  });

  it('takes back a line Shift+Return just opened in one keystroke', () => {
    expect(
      reconcileBodyChange('1. a\n   ', '1. a\n  ', { start: 8, end: 8 }, { key: 'Backspace' }),
    ).toEqual({ text: '1. a', selection: { start: 4, end: 4 } });
  });

  it('joins onto the continuation line above it', () => {
    expect(deleteBackwardEdit('- a\n  b\n  c', { start: 10, end: 10 })).toEqual({
      text: '- a\n  bc',
      selection: { start: 7, end: 7 },
    });
  });

  it('is ordinary deletion anywhere else on the line', () => {
    expect(deleteBackwardEdit('- a\n  bc', { start: 7, end: 7 })).toBeNull();
    expect(deleteBackwardEdit('- a\n  bc', { start: 5, end: 5 })).toBeNull();
    expect(deleteBackwardEdit('- a\n  bc', { start: 5, end: 6 })).toBeNull();
  });

  it('leaves an indented prose line that is no continuation alone', () => {
    expect(deleteBackwardEdit('a\n  b', { start: 4, end: 4 })).toBeNull();
  });
});

describe('Tab and Shift+Tab with continuation lines', () => {
  it('moves an item’s continuation lines in with it', () => {
    expect(shiftListLines('- a\n- b\n  more\n  still', { start: 6, end: 6 }, 'indent')).toEqual({
      text: '- a\n  - b\n    more\n    still',
      selection: { start: 8, end: 8 },
    });
  });

  it('moves them back out with it', () => {
    expect(shiftListLines('- a\n  - b\n    more', { start: 8, end: 8 }, 'outdent')).toEqual({
      text: '- a\n- b\n  more',
      selection: { start: 6, end: 6 },
    });
  });

  it('moves the owning item when the caret is on a continuation line', () => {
    expect(shiftListLines('- a\n- b\n  more', { start: 12, end: 12 }, 'indent')).toEqual({
      text: '- a\n  - b\n    more',
      selection: { start: 16, end: 16 },
    });
  });

  it('renumbers a numbered item that moves with its continuation line', () => {
    expect(shiftListLines('1. a\n2. b\n   more\n3. c', { start: 8, end: 8 }, 'indent')?.text).toBe(
      '1. a\n  1. b\n     more\n2. c',
    );
  });

  it('keeps a tab-indented item and its continuation on the same tab stop', () => {
    expect(
      shiftListLines('\t- a\n\t\t- b\n\t\t  more', { start: 9, end: 9 }, 'outdent')?.text,
    ).toBe('\t- a\n\t- b\n\t  more');
  });

  it('indents a continuation line that does not share its item’s indent from its start', () => {
    // Every indented item here uses a tab, so a tab is this document's unit.
    expect(shiftListLines('- a\n\t- b\n          more', { start: 7, end: 7 }, 'indent')?.text).toBe(
      '- a\n\t\t- b\n\t          more',
    );
  });

  it('leaves such a line where it is on outdent, still under the item', () => {
    const edit = shiftListLines('- a\n\t- b\n          more', { start: 7, end: 7 }, 'outdent');
    expect(edit?.text).toBe('- a\n- b\n          more');
    expect(kinds(edit!.text)).toEqual(['bullet', 'bullet', 'continuation']);
  });

  it('reports the owning item’s level on a continuation line', () => {
    expect(listLevelAt('- a\n  - b\n    more', 16)).toBe(1);
    expect(listLevelAt('- a\n  more', 8)).toBe(0);
  });
});

describe('renumbering across continuation lines', () => {
  it('steps over a continuation line, even one that holds only its indent', () => {
    expect(drawn(press('1. a\n   \n2. b', 4, RETURN))).toBe('1. a\n2. |\n   \n3. b');
  });
});
