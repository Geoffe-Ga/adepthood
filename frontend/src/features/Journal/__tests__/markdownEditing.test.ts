import { describe, expect, it } from '@jest/globals';

import { continueMarkdownEdit, continueMarkdownLine, deleteBackwardEdit } from '../markdownEditing';

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

  it('removes an indented prefix back to the line start', () => {
    expect(deleteBackwardEdit('a\n  - two', { start: 6, end: 6 })).toEqual({
      text: 'a\ntwo',
      selection: { start: 2, end: 2 },
    });
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
