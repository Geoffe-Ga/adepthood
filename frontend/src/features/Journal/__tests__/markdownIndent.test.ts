import { describe, expect, it } from '@jest/globals';

import { JOURNAL_TAB_COLUMNS } from '../journalMarkdown';
import {
  DEFAULT_INDENT_UNIT,
  TAB_INDENT_UNIT,
  WIDE_INDENT_UNIT,
  inferIndentUnit,
  outdentIndent,
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
