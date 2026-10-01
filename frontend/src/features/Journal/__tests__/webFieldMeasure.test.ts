import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { readWebContentHeight } from '../webFieldMeasure';

const Platform = require('react-native').Platform as { OS: string };

const MEASURED = 512.4;

describe('readWebContentHeight (#3001)', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an object with no scrollHeight', {}],
    ['a string scrollHeight', { scrollHeight: '5' }],
    ['a NaN scrollHeight', { scrollHeight: Number.NaN }],
    ['an infinite scrollHeight', { scrollHeight: Number.POSITIVE_INFINITY }],
    ['a zero scrollHeight (hidden or detached)', { scrollHeight: 0 }],
    ['a negative scrollHeight', { scrollHeight: -1 }],
  ])('measures nothing from %s', (_label, node) => {
    expect(readWebContentHeight(node)).toBeUndefined();
  });

  it("returns a web field's scrollHeight as reported", () => {
    expect(readWebContentHeight({ scrollHeight: MEASURED })).toBe(MEASURED);
  });

  it('reads nothing off the host node on native', () => {
    Platform.OS = 'ios';
    const read = jest.fn(() => MEASURED);
    const node = {};
    Object.defineProperty(node, 'scrollHeight', { get: read });
    expect(readWebContentHeight(node)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
