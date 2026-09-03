import { describe, expect, it } from '@jest/globals';

import { continueMarkdownLine } from '../markdownEditing';

describe('continueMarkdownLine', () => {
  it.each([
    ['- First thought\n', '- First thought\n- '],
    ['* First thought\n', '* First thought\n* '],
    ['> A remembered phrase\n', '> A remembered phrase\n> '],
  ])('continues the active Markdown prefix', (typed, expected) => {
    expect(continueMarkdownLine(typed.slice(0, -1), typed)).toBe(expected);
  });

  it('leaves inline bold and italic Markdown untouched', () => {
    const markdown = 'This is **strong** and _soft_.';
    expect(continueMarkdownLine('', markdown)).toBe(markdown);
  });

  it.each(['- \n', '* \n', '> \n'])('ends an empty Markdown block cleanly', (typed) => {
    expect(continueMarkdownLine(typed.slice(0, -1), typed)).toBe('');
  });
});
