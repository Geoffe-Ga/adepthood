import { describe, expect, it } from '@jest/globals';

import { MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';
import {
  parseContentIdParam,
  parseScrollOffsetParam,
  parseStageNumberParam,
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

  it.each(['0', '-3', '2.5', 'x', '', UNSAFE_INTEGER])('rejects %p as undefined', (raw) => {
    expect(parseContentIdParam(raw)).toBeUndefined();
  });
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
