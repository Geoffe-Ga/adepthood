import { describe, expect, it } from '@jest/globals';

import { continueMarkdownEdit, continueMarkdownLine } from '../markdownEditing';

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
