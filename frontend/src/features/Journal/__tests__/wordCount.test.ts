/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { countWords, wordCountLabel } from '../wordCount';

describe('countWords', () => {
  it.each([
    ['an empty body', '', 0],
    ['whitespace only', '   \n\t  ', 0],
    ['a single word', 'willow', 1],
    ['leading and trailing whitespace', '  the river  ', 2],
    ['runs of mixed whitespace', 'the\n\n  river \t ran', 3],
    ['a non-breaking space separator', 'the river', 2],
  ])('counts %s', (_case, body, expected) => {
    expect(countWords(body)).toBe(expected);
  });

  it.each([
    ['a hyphenated compound as one word', 'well-being', 1],
    ['a straight apostrophe as intra-word', "don't", 1],
    ['a typographic apostrophe as intra-word', 'don’t', 1],
    ['a Unicode hyphen as intra-word', 'well‐being', 1],
    ['a decimal number as one word', '3.14', 1],
    ['a thousands separator as one word', '1,000', 1],
    ['an ordinal as one word', '21st', 1],
  ])('treats %s', (_case, body, expected) => {
    expect(countWords(body)).toBe(expected);
  });

  it.each([
    ['an em dash between words', 'time—space', 2],
    ['an en dash between words', 'time–space', 2],
    ['a slash between words', 'and/or', 2],
    ['a missing space after a full stop', 'It ended.Then it began.', 5],
  ])('splits on %s', (_case, body, expected) => {
    expect(countWords(body)).toBe(expected);
  });

  it.each([
    ['a lone em dash', '—', 0],
    ['an ellipsis', '…', 0],
    ['a run of punctuation', '*** --- ???', 0],
    ['surrounding quotes and commas', '"Hello," she said.', 3],
    ['a bare emoji', '🌙', 0],
    ['an emoji beside a word', 'moon 🌙', 1],
  ])('ignores %s', (_case, body, expected) => {
    expect(countWords(body)).toBe(expected);
  });

  it.each([
    ['accented Latin', 'café brûlé', 2],
    ['Cyrillic', 'река течёт', 2],
    ['space-separated Hangul', '강이 흐른다', 2],
  ])('counts %s by whitespace like any prose', (_case, body, expected) => {
    expect(countWords(body)).toBe(expected);
  });

  it.each([
    ['Han characters', '川流', 2],
    ['Hiragana', 'かわ', 2],
    ['Han beside Latin prose', '川 flows', 2],
  ])('counts each of %s as its own word (they are written unspaced)', (_case, body, expected) => {
    expect(countWords(body)).toBe(expected);
  });

  it('counts a realistic paragraph', () => {
    const body =
      'I walked to the river before dawn — the mist had not yet lifted,\n' +
      "and the willow's roots were dark with water. I didn't write anything down.";
    expect(countWords(body)).toBe(26);
  });
});

describe('wordCountLabel', () => {
  it('says nothing on a blank page rather than announcing a zero', () => {
    expect(wordCountLabel(0)).toBe('');
  });

  it('uses the singular for one word', () => {
    expect(wordCountLabel(1)).toBe('1 word');
  });

  it('uses the plural beyond one', () => {
    expect(wordCountLabel(2)).toBe('2 words');
  });

  it('groups thousands so a long page stays readable at a glance', () => {
    expect(wordCountLabel(1234)).toBe('1,234 words');
  });
});
