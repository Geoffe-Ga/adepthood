import { describe, expect, it } from '@jest/globals';

import { parseJournalMarkdown, serializeJournalMarkdown } from '../journalMarkdown';
import {
  continueMarkdownEdit,
  continueMarkdownLine,
  deleteBackwardEdit,
  minimalReplacement,
  reconcileBodyChange,
} from '../markdownEditing';

describe('continueMarkdownLine', () => {
  it.each([
    ['- First thought\n', '- First thought\n- '],
    ['* First thought\n', '* First thought\n* '],
    ['+ First thought\n', '+ First thought\n+ '],
    ['> A remembered phrase\n', '> A remembered phrase\n> '],
  ])('continues the active Markdown prefix', (typed, expected) => {
    expect(continueMarkdownLine(typed.slice(0, -1), typed)).toBe(expected);
  });

  it('leaves inline bold and italic Markdown untouched', () => {
    const markdown = 'This is **strong** and _soft_.';
    expect(continueMarkdownLine('', markdown)).toBe(markdown);
  });

  it.each(['- \n', '* \n', '+ \n', '> \n'])('ends an empty Markdown block cleanly', (typed) => {
    expect(continueMarkdownLine(typed.slice(0, -1), typed)).toBe('');
  });

  it.each([
    ['- First thought\nClosing', '- First thought\n\nClosing', '- First thought\n- \nClosing'],
    [
      '  * Nested thought\nClosing',
      '  * Nested thought\n\nClosing',
      '  * Nested thought\n  * \nClosing',
    ],
    [
      '> A remembered phrase\nClosing',
      '> A remembered phrase\n\nClosing',
      '> A remembered phrase\n> \nClosing',
    ],
  ])('continues a Markdown block where Return was pressed', (previous, next, expected) => {
    expect(continueMarkdownLine(previous, next)).toBe(expected);
  });

  it('exits an empty Markdown block in the middle without dropping the suffix', () => {
    expect(continueMarkdownLine('Intro\n- \nClosing', 'Intro\n- \n\nClosing')).toBe(
      'Intro\n\nClosing',
    );
  });

  it('does not restart a list when Return is pressed after an exited block', () => {
    const previous = '- First thought\n';
    const next = '- First thought\n\n';
    expect(
      continueMarkdownEdit(previous, next, {
        start: previous.length,
        end: previous.length,
      }),
    ).toEqual({ text: next });
  });

  it('places the caret after the inserted prefix using native UTF-16 offsets', () => {
    const previous = '💡\n- First thought\nClosing';
    const next = '💡\n- First thought\n\nClosing';
    const edit = continueMarkdownEdit(previous, next);
    expect(edit.text).toBe('💡\n- First thought\n- \nClosing');
    expect(edit.selection).toEqual({
      start: '💡\n- First thought\n- '.length,
      end: '💡\n- First thought\n- '.length,
    });
  });

  it.each([
    ['plain', 'plain text pasted'],
    ['plain text', 'plain'],
    ['**bold** and _italic_', '**bold** and _italic_ plus *more*'],
  ])('does not rewrite deletion, paste, or inline Markdown', (previous, next) => {
    expect(continueMarkdownEdit(previous, next)).toEqual({ text: next });
  });
});

describe('continueMarkdownEdit -- Return on an empty nested list item', () => {
  it('outdents an empty nested item one level instead of exiting the list', () => {
    expect(continueMarkdownEdit('- a\n  - ', '- a\n  - \n', { start: 8, end: 8 })).toEqual({
      text: '- a\n- ',
      selection: { start: 6, end: 6 },
    });
  });

  it("outdents by the document's own unit: four spaces", () => {
    const previous = '- a\n    - b\n        - ';
    expect(
      continueMarkdownEdit(previous, `${previous}\n`, {
        start: previous.length,
        end: previous.length,
      }),
    ).toEqual({ text: '- a\n    - b\n    - ', selection: { start: 18, end: 18 } });
  });

  it("outdents by the document's own unit: a tab, keeping the typed marker", () => {
    const previous = '* a\n\t\t* ';
    expect(
      continueMarkdownEdit(previous, `${previous}\n`, {
        start: previous.length,
        end: previous.length,
      }),
    ).toEqual({ text: '* a\n\t* ', selection: { start: 7, end: 7 } });
  });

  it('keeps the text after the item when it outdents mid-document', () => {
    expect(
      continueMarkdownEdit('- a\n  + \nafter', '- a\n  + \n\nafter', { start: 8, end: 8 }),
    ).toEqual({ text: '- a\n+ \nafter', selection: { start: 6, end: 6 } });
  });

  it('still exits an empty level-0 item outright', () => {
    expect(continueMarkdownEdit('- a\n- ', '- a\n- \n', { start: 6, end: 6 })).toEqual({
      text: '- a\n',
      selection: { start: 4, end: 4 },
    });
  });

  it('exits an empty indented quote outright rather than promoting it to a real quote', () => {
    // '  > ' renders as prose (an indented > is not a quote), so outdenting it
    // to '> ' would silently turn the writer's line into a quote block.
    expect(continueMarkdownEdit('x\n  > ', 'x\n  > \n', { start: 6, end: 6 })).toEqual({
      text: 'x\n',
      selection: { start: 2, end: 2 },
    });
  });
});

describe('continueMarkdownEdit -- marker separators the shared classifier must not flatten', () => {
  it('leaves a bare > alone instead of treating it as an empty quote to exit', () => {
    // A bare `>` classifies as a QUOTE with no content (journalMarkdown has
    // rendered it that way since the dialect landed), so a classifier-driven
    // rewrite that keys the empty-marker exit off `contentStart === end` would
    // delete the writer's `>`. The exit path fires on an empty SEPARATED marker
    // only -- `markerFollowedBy` of 'space' or 'tab'.
    expect(continueMarkdownEdit('>', '>\n', { start: 1, end: 1 })).toEqual({ text: '>\n' });
  });

  it('continues a list item whose marker is separated by a tab', () => {
    expect(continueMarkdownEdit('-\tfoo', '-\tfoo\n', { start: 5, end: 5 })).toEqual({
      text: '-\tfoo\n- ',
      selection: { start: 8, end: 8 },
    });
  });

  it('does not continue a marker glued to its content', () => {
    expect(continueMarkdownEdit('-no-space', '-no-space\n', { start: 9, end: 9 })).toEqual({
      text: '-no-space\n',
    });
  });

  it('does not continue a marker separated by exotic whitespace', () => {
    expect(continueMarkdownEdit('-\u00a0foo', '-\u00a0foo\n', { start: 5, end: 5 })).toEqual({
      text: '-\u00a0foo\n',
    });
  });
});

describe('deleteBackwardEdit', () => {
  it('removes a whole hidden bullet prefix atomically at the content start', () => {
    expect(deleteBackwardEdit('- one', { start: 2, end: 2 })).toEqual({
      text: 'one',
      selection: { start: 0, end: 0 },
    });
  });

  it('outdents a nested list item one level instead of removing its prefix', () => {
    // #2890: Backspace at a nested item's content start steps it out a level;
    // only a level-0 item loses its prefix.
    expect(deleteBackwardEdit('a\n  - two', { start: 6, end: 6 })).toEqual({
      text: 'a\n- two',
      selection: { start: 4, end: 4 },
    });
  });

  it('outdents an empty nested item, then removes the prefix at level 0', () => {
    const first = deleteBackwardEdit('- a\n  - b\n    - ', { start: 16, end: 16 });
    expect(first).toEqual({ text: '- a\n  - b\n  - ', selection: { start: 14, end: 14 } });
    const second = deleteBackwardEdit(first!.text, first!.selection!);
    expect(second).toEqual({ text: '- a\n  - b\n- ', selection: { start: 12, end: 12 } });
    expect(deleteBackwardEdit(second!.text, second!.selection!)).toEqual({
      text: '- a\n  - b\n',
      selection: { start: 10, end: 10 },
    });
  });

  it('removes an indented quote-looking prefix never, since it renders as prose', () => {
    expect(deleteBackwardEdit('  > q', { start: 4, end: 4 })).toBeNull();
  });

  it('removes a quote prefix the same way', () => {
    expect(deleteBackwardEdit('> quoted', { start: 2, end: 2 })).toEqual({
      text: 'quoted',
      selection: { start: 0, end: 0 },
    });
  });

  it('measures the caret in UTF-16 units, as the TextInput reports it', () => {
    const body = '\u{1F4A1}\n- listed';
    expect(deleteBackwardEdit(body, { start: 5, end: 5 })).toEqual({
      text: '\u{1F4A1}\nlisted',
      selection: { start: 3, end: 3 },
    });
  });

  it.each([
    ['- one', { start: 3, end: 3 }],
    ['- one', { start: 0, end: 0 }],
    ['plain text', { start: 4, end: 4 }],
    ['- one', { start: 2, end: 4 }],
  ])('defers to the plain field for %j at %j', (body, selection) => {
    expect(deleteBackwardEdit(body, selection)).toBeNull();
  });

  /**
   * A PLAIN line's content starts at the line's own start, so without the
   * `contentStart === start` guard every plain line after the first matches
   * here and Backspace is answered with a no-op edit: the handler consumes the
   * keypress, hands the field back an unchanged body, and the line feed can
   * never be deleted. The rows above cannot see this -- three sit on `- one`
   * and the fourth puts the caret mid-line, so none is a caret at the start of
   * a plain line that is not line 0.
   */
  it.each([
    ['a\nb', 2],
    ['- one\ntwo', 6],
    ['a\n\nb', 2],
  ])('defers to the plain field at the start of plain line %j:%i', (body, caret) => {
    expect(deleteBackwardEdit(body, { start: caret, end: caret })).toBeNull();
  });
});

describe('minimalReplacement', () => {
  it.each([
    ['a word', 'a **word**', { start: 2, end: 6, text: '**word**' }],
    ['a **word**', 'a word', { start: 2, end: 10, text: 'word' }],
    ['- a', '  - a', { start: 0, end: 0, text: '  ' }],
    ['  - a', '- a', { start: 0, end: 2, text: '' }],
    ['same', 'same', { start: 4, end: 4, text: '' }],
  ])('replaces the one differing stretch of %j to reach %j', (before, after, expected) => {
    const replacement = minimalReplacement(before, after);
    expect(replacement).toEqual(expected);
    expect(
      `${before.slice(0, replacement.start)}${replacement.text}${before.slice(replacement.end)}`,
    ).toBe(after);
  });

  it('never splits a surrogate pair', () => {
    // '\u{1F600}' and '\u{1F601}' share their high surrogate; a UTF-16 prefix
    // match would leave a lone low surrogate as the "replacement".
    const replacement = minimalReplacement('\u{1F600}', '\u{1F601}');
    expect(replacement).toEqual({ start: 0, end: 2, text: '\u{1F601}' });
  });

  it('never splits a surrogate pair at the end of the shared suffix', () => {
    // U+10000 and U+10400 share their LOW surrogate, U+DC00.
    const replacement = minimalReplacement('a\u{10000}', 'a\u{10400}');
    expect(replacement).toEqual({ start: 1, end: 3, text: '\u{10400}' });
  });
});

describe('reconcileBodyChange', () => {
  it("turns a Backspace at a nested item's content start into an outdent", () => {
    // The field already removed the separator; the edit replaces that result.
    expect(reconcileBodyChange('- a\n  - b', '- a\n  -b', { start: 8, end: 8 })).toEqual({
      text: '- a\n- b',
      selection: { start: 6, end: 6 },
    });
  });

  it('removes a level-0 prefix on Backspace at its content start', () => {
    expect(reconcileBodyChange('- one', '-one', { start: 2, end: 2 })).toEqual({
      text: 'one',
      selection: { start: 0, end: 0 },
    });
  });

  it('leaves a Backspace anywhere else to the field', () => {
    expect(reconcileBodyChange('- one', '- oe', { start: 4, end: 4 })).toEqual({ text: '- oe' });
  });

  it('ignores a stale selection that does not explain the change', () => {
    expect(reconcileBodyChange('- one', '-one', { start: 5, end: 5 })).toEqual({ text: '-one' });
  });

  it('never reads a range deletion as Backspace', () => {
    expect(reconcileBodyChange('- one', '-one', { start: 1, end: 2 })).toEqual({ text: '-one' });
  });

  it('ignores a deletion of more than one character', () => {
    expect(reconcileBodyChange('- one', 'one', { start: 2, end: 2 })).toEqual({ text: 'one' });
  });

  it('counts a surrogate pair as the one character Backspace removes', () => {
    const previous = '\u{1F600}- a\n  - b';
    // Backspace after the emoji removes both UTF-16 units: plain deletion.
    expect(reconcileBodyChange(previous, '- a\n  - b', { start: 2, end: 2 })).toEqual({
      text: '- a\n  - b',
    });
    // Backspace at the nested item's content start (UTF-16 10) still outdents.
    expect(reconcileBodyChange(previous, '\u{1F600}- a\n  -b', { start: 10, end: 10 })).toEqual({
      text: '\u{1F600}- a\n- b',
      selection: { start: 8, end: 8 },
    });
  });

  it('leaves a forward Delete alone even where it looks like Backspace', () => {
    // '-  x' with the caret at 2: Backspace and Delete both yield '- x'.
    expect(reconcileBodyChange('-  x', '- x', { start: 2, end: 2 }, { key: 'Delete' })).toEqual({
      text: '- x',
    });
    expect(reconcileBodyChange('-  x', '- x', { start: 2, end: 2 })).toEqual({
      text: ' x',
      selection: { start: 0, end: 0 },
    });
  });

  it('still continues a list on Return', () => {
    expect(reconcileBodyChange('- a', '- a\n', { start: 3, end: 3 })).toEqual({
      text: '- a\n- ',
      selection: { start: 6, end: 6 },
    });
  });

  it('stores a pasted multi-line list byte for byte, markers and indents as typed', () => {
    const pasted = '- a\n\t* b\n    + c\n  - d';
    const edit = reconcileBodyChange('', pasted, { start: 0, end: 0 });
    expect(edit).toEqual({ text: pasted });
    expect(serializeJournalMarkdown(parseJournalMarkdown(edit.text))).toBe(pasted);
  });
});

/** Press Return with the caret just after ``before`` in ``body``. */
function pressReturn(body: string, before: string) {
  const caret = body.indexOf(before) + before.length;
  const next = `${body.slice(0, caret)}\n${body.slice(caret)}`;
  return continueMarkdownEdit(body, next, { start: caret, end: caret });
}

describe('continueMarkdownEdit -- numbered lists', () => {
  it('gives the next number and renumbers the items below', () => {
    expect(pressReturn('1. walked\n2. wrote\n3. slept', 'wrote')).toEqual({
      text: '1. walked\n2. wrote\n3. \n4. slept',
      selection: { start: 22, end: 22 },
    });
  });

  it.each([
    ['1. a', '1. a\n2. '],
    ['1) a', '1) a\n2) '],
    ['  3. a', '  3. a\n  4. '],
    ['\t9. a', '\t9. a\n\t10. '],
    ['1.\ta', '1.\ta\n2. '],
    ['007. a', '007. a\n8. '],
  ])('continues %j', (body, expected) => {
    const edit = pressReturn(body, 'a');
    expect(edit.text).toBe(expected);
    expect(edit.selection).toEqual({ start: expected.length, end: expected.length });
  });

  it('splits an item at the caret and numbers the second half', () => {
    expect(pressReturn('1. walked\n2. slept', 'wal').text).toBe('1. wal\n2. ked\n3. slept');
  });

  it('renumbers only the same level of the same run', () => {
    expect(pressReturn('1. a\n   note\n  - child\n2. b\n\n2. c', 'a').text).toBe(
      '1. a\n2. \n   note\n  - child\n3. b\n\n2. c',
    );
    expect(pressReturn('1. a\n2. b\n- c\n3. d', 'a').text).toBe('1. a\n2. \n3. b\n- c\n3. d');
    expect(pressReturn('- p\n  1. a\n  2. b\n- q', 'a').text).toBe(
      '- p\n  1. a\n  2. \n  3. b\n- q',
    );
  });

  it('keeps each following item its own punctuation and never touches the items above', () => {
    expect(pressReturn('5. a\n5. b\n5) c', 'b').text).toBe('5. a\n5. b\n6. \n7) c');
  });

  it('never writes a number too long to be read back as one', () => {
    expect(pressReturn('999999999. a', 'a').text).toBe('999999999. a\n999999999. ');
  });

  it('exits an empty level-0 item, leaving the items below as typed', () => {
    expect(pressReturn('1. a\n2. \n3. b', '2. ')).toEqual({
      text: '1. a\n\n3. b',
      selection: { start: 5, end: 5 },
    });
  });

  it('steps an empty nested item out into the run above and renumbers what follows', () => {
    expect(pressReturn('1. a\n  1. x\n  2. \n2. b', '  2. ')).toEqual({
      text: '1. a\n  1. x\n2. \n3. b',
      selection: { start: 15, end: 15 },
    });
  });

  it('starts at 1. when it steps out to a level with no numbered item above', () => {
    expect(pressReturn('- a\n  4. ', '  4. ')).toEqual({
      text: '- a\n1. ',
      selection: { start: 7, end: 7 },
    });
  });

  it('leaves a number with no separator, which is prose, alone', () => {
    expect(pressReturn('1.a', '1.a')).toEqual({ text: '1.a\n' });
    expect(pressReturn('1.', '1.')).toEqual({ text: '1.\n' });
  });
});

describe('continueMarkdownEdit -- task items', () => {
  it.each([
    ['- [x] called Sam', '- [x] called Sam\n- [ ] '],
    ['- [ ] called Sam', '- [ ] called Sam\n- [ ] '],
    ['* [X] called Sam', '* [X] called Sam\n* [ ] '],
    ['  + [ ] called Sam', '  + [ ] called Sam\n  + [ ] '],
  ])('continues %j with an unchecked box', (body, expected) => {
    expect(pressReturn(body, 'Sam')).toEqual({
      text: expected,
      selection: { start: expected.length, end: expected.length },
    });
  });

  it.each(['- [ ] ', '- [x] ', '- [ ]'])('exits an empty level-0 task %j', (body) => {
    expect(pressReturn(`${body}\nafter`, body)).toEqual({
      text: '\nafter',
      selection: { start: 0, end: 0 },
    });
  });

  it('steps an empty nested task out one level, keeping a box', () => {
    expect(pressReturn('- [x] a\n  - [ ] ', '  - [ ] ')).toEqual({
      text: '- [x] a\n- [ ] ',
      selection: { start: 14, end: 14 },
    });
  });
});

describe('continueMarkdownEdit -- headings and rules', () => {
  it.each(['# Title', '### Deep', '---', '***', '___'])('does not continue %j', (body) => {
    expect(pressReturn(body, body)).toEqual({ text: `${body}\n` });
  });

  it('exits an empty heading', () => {
    expect(pressReturn('a\n## \nb', '## ')).toEqual({
      text: 'a\n\nb',
      selection: { start: 2, end: 2 },
    });
  });
});

describe('deleteBackwardEdit -- numbered and task items', () => {
  it('drops a level-0 numbered prefix in one step, leaving the items below as typed', () => {
    expect(deleteBackwardEdit('1. a\n2. b\n3. c', { start: 8, end: 8 })).toEqual({
      text: '1. a\nb\n3. c',
      selection: { start: 5, end: 5 },
    });
  });

  it('steps a nested numbered item out one level and renumbers', () => {
    expect(deleteBackwardEdit('1. a\n  1. b\n2. c', { start: 10, end: 10 })).toEqual({
      text: '1. a\n2. b\n3. c',
      selection: { start: 8, end: 8 },
    });
  });

  it('steps a nested task out, then drops its whole prefix at level 0', () => {
    const first = deleteBackwardEdit('- [ ] a\n  - [x] b', { start: 16, end: 16 });
    expect(first).toEqual({ text: '- [ ] a\n- [x] b', selection: { start: 14, end: 14 } });
    expect(deleteBackwardEdit(first!.text, first!.selection!)).toEqual({
      text: '- [ ] a\nb',
      selection: { start: 8, end: 8 },
    });
  });
});

describe('reconcileBodyChange -- numbers are only rewritten by Return and indent', () => {
  it.each([
    ['', '1. a\n1. b\n7. c', { start: 0, end: 0 }, undefined],
    ['1. a\n3. c', '1. a\n3. cd', { start: 9, end: 9 }, undefined],
    ['1. a\n2. b\n3. c', '1. a\n3. c', { start: 5, end: 10 }, undefined],
    ['1. a\n\n3. c', '1. a\n3. c', { start: 4, end: 4 }, { key: 'Delete' }],
    ['1. a\n\n3. c', '1. a\n3. c', { start: 5, end: 5 }, undefined],
  ])('keeps %j -> %j as the field reported it', (previous, next, selection, key) => {
    expect(reconcileBodyChange(previous, next, selection, key)).toEqual({ text: next });
  });

  it('continues a numbered list on Return', () => {
    expect(reconcileBodyChange('1. a\n2. b', '1. a\n\n2. b', { start: 4, end: 4 })).toEqual({
      text: '1. a\n2. \n3. b',
      selection: { start: 8, end: 8 },
    });
  });
});

describe('a renumbering Return is one contiguous edit', () => {
  it('keeps an anchor below a renumbered 10. on its own words', () => {
    const items = Array.from({ length: 10 }, (_, index) => `${String(index + 1)}. item`);
    const before = `${items.join('\n')}\nThe willow leans.`;
    const { text: after } = pressReturn(before, '3. item');
    expect(after).toContain('\n4. \n5. item');
    expect(after).toContain('\n11. item\nThe willow leans.');

    // The server re-anchors by ONE edit window (``reanchor_one``): an anchor
    // wholly after it moves by the net change in length.
    const window = minimalReplacement(before, after);
    const anchorText = 'willow';
    const anchorStart = before.indexOf(anchorText);
    expect(anchorStart).toBeGreaterThanOrEqual(window.end);
    const shifted = anchorStart + window.text.length - (window.end - window.start);
    expect(after.slice(shifted, shifted + anchorText.length)).toBe(anchorText);
    expect(`${before.slice(0, window.start)}${window.text}${before.slice(window.end)}`).toBe(after);
  });
});
