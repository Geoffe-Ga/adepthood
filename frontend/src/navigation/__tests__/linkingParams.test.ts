import { describe, expect, it } from '@jest/globals';

import { MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';
import {
  parseContentIdParam,
  parseHighlightSpanParam,
  parseScrollOffsetParam,
  parseStageNumberParam,
  stringifyHighlightSpanParam,
} from '@/navigation/linkingParams';

/** A digit run long enough that ``Number()`` overflows to ``Infinity``. */
const OVERFLOWING_DIGITS = '9'.repeat(400);
/** One past ``Number.MAX_SAFE_INTEGER``: all digits, but not a safe integer. */
const UNSAFE_INTEGER = '9007199254740993';

describe('parseStageNumberParam', () => {
  it.each([
    [String(MIN_STAGE), MIN_STAGE],
    [String(MAX_STAGE), MAX_STAGE],
    ['3', 3],
  ])('accepts %p as stage %p', (raw, expected) => {
    expect(parseStageNumberParam(raw)).toBe(expected);
  });

  it.each([
    String(MIN_STAGE - 1),
    String(MAX_STAGE + 1),
    '',
    ' 1',
    '-1',
    '1e1',
    '0x1',
    '01x',
    '1.5',
    'abc',
  ])('rejects %p as undefined, never NaN or a string', (raw) => {
    expect(parseStageNumberParam(raw)).toBeUndefined();
  });
});

describe('parseContentIdParam', () => {
  it('accepts a positive integer id', () => {
    expect(parseContentIdParam('5')).toBe(5);
  });

  it.each(['0', '-3', '2.5', 'x', '', '1e1', '0x5', ' 5', UNSAFE_INTEGER])(
    'rejects %p as undefined',
    (raw) => {
      expect(parseContentIdParam(raw)).toBeUndefined();
    },
  );
});

describe('parseScrollOffsetParam', () => {
  it.each([
    ['0', 0],
    ['120', 120],
    ['120.5', 120.5],
  ])('accepts %p as offset %p', (raw, expected) => {
    expect(parseScrollOffsetParam(raw)).toBe(expected);
  });

  it.each(['-1', 'abc', '', ' 1', 'Infinity', 'NaN', '1e3'])('rejects %p as undefined', (raw) => {
    expect(parseScrollOffsetParam(raw)).toBeUndefined();
  });

  it('rejects a digit run that overflows to Infinity', () => {
    expect(parseScrollOffsetParam(OVERFLOWING_DIGITS)).toBeUndefined();
  });
});

/**
 * A Course quote's Open carries the passage to preselect (#3659). On the web the
 * route's params are the URL's query, which can hold only strings: an object
 * would print as ``[object Object]`` and read back as that string.
 */
describe('highlightSpan codec', () => {
  it('writes a span as start-end, leaving its words out of the URL', () => {
    expect(stringifyHighlightSpanParam({ start: 8, end: 32, text: 'the body keeps' })).toBe('8-32');
  });

  it('reads start-end back as a span with no words to check', () => {
    expect(parseHighlightSpanParam('8-32')).toEqual({ start: 8, end: 32 });
    expect(parseHighlightSpanParam('0-1')).toEqual({ start: 0, end: 1 });
  });

  it.each([
    '',
    '8',
    '8-',
    '-32',
    '32-8',
    '8-8',
    'a-b',
    '1.5-4',
    '[object Object]',
    `0-${UNSAFE_INTEGER}`,
  ])('reads %p as no passage asked for', (raw) => {
    expect(parseHighlightSpanParam(raw)).toBeUndefined();
  });
});
