import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { onWebFontsSettled, readWebContentHeight, readWebNaturalHeight } from '../webFieldMeasure';

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

const NATURAL = 96.5;
const LIVE_HEIGHT = 300;

/** A rendered host textarea whose copy measures ``natural``, with the copy observable. */
function hostTextarea(natural: number, liveHeight = LIVE_HEIGHT) {
  const twin = {
    style: {} as Record<string, string>,
    value: '',
    scrollHeight: natural,
    removeAttribute: jest.fn(),
    setAttribute: jest.fn(),
    remove: jest.fn(),
  };
  const appendChild = jest.fn();
  const node = {
    scrollHeight: liveHeight,
    value: 'the title as typed',
    ownerDocument: {
      body: { appendChild },
      defaultView: { getComputedStyle: () => ({ width: '358px' }) },
    },
    cloneNode: jest.fn(() => twin),
  };
  return { node, twin, appendChild };
}

describe('readWebNaturalHeight (#3325)', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('reads the text height off an unseen zero-height copy at the same width', () => {
    const { node, twin, appendChild } = hostTextarea(NATURAL);
    expect(readWebNaturalHeight(node)).toBe(NATURAL);
    expect(node.cloneNode).toHaveBeenCalledWith(false);
    expect(twin.value).toBe('the title as typed');
    expect(twin.style).toMatchObject({
      position: 'absolute',
      visibility: 'hidden',
      height: '0px',
      minHeight: '0px',
      width: '358px',
    });
    expect(twin.removeAttribute).toHaveBeenCalledWith('data-testid');
    expect(twin.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
    expect(appendChild).toHaveBeenCalledWith(twin);
    expect(twin.remove).toHaveBeenCalledTimes(1);
  });

  it('reports less than the live height, so a widened field can shrink', () => {
    const { node } = hostTextarea(NATURAL, LIVE_HEIGHT);
    expect(readWebNaturalHeight(node)).toBeLessThan(LIVE_HEIGHT);
  });

  it('measures nothing from an unrendered field', () => {
    const { node } = hostTextarea(NATURAL, 0);
    expect(readWebNaturalHeight(node)).toBeUndefined();
    expect(node.cloneNode).not.toHaveBeenCalled();
  });

  it('measures nothing when the copy reports no height', () => {
    const { node } = hostTextarea(0);
    expect(readWebNaturalHeight(node)).toBeUndefined();
  });

  it.each([
    ['a node that cannot be copied', { scrollHeight: LIVE_HEIGHT, value: 'v', ownerDocument: {} }],
    [
      'a node with no value',
      { scrollHeight: LIVE_HEIGHT, cloneNode: () => ({}), ownerDocument: {} },
    ],
    ['a node with no document', { scrollHeight: LIVE_HEIGHT, value: 'v', cloneNode: () => ({}) }],
    [
      'a node whose document has no window',
      {
        scrollHeight: LIVE_HEIGHT,
        value: 'v',
        cloneNode: () => ({}),
        ownerDocument: { body: {}, defaultView: null },
      },
    ],
  ])('measures nothing from %s', (_label, node) => {
    expect(readWebNaturalHeight(node)).toBeUndefined();
  });

  it('copies nothing on native', () => {
    Platform.OS = 'ios';
    const { node } = hostTextarea(NATURAL);
    expect(readWebNaturalHeight(node)).toBeUndefined();
    expect(node.cloneNode).not.toHaveBeenCalled();
  });
});

describe('onWebFontsSettled (#3325)', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
    delete (globalThis as { document?: unknown }).document;
  });

  it('listens for a finished font load and stops when unsubscribed', () => {
    const fonts = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    (globalThis as { document?: unknown }).document = { fonts };
    const settled = jest.fn();
    const stop = onWebFontsSettled(settled);
    expect(fonts.addEventListener).toHaveBeenCalledWith('loadingdone', settled);
    stop();
    expect(fonts.removeEventListener).toHaveBeenCalledWith('loadingdone', settled);
  });

  it('subscribes to nothing where the page has no font set', () => {
    (globalThis as { document?: unknown }).document = {};
    expect(() => onWebFontsSettled(jest.fn())()).not.toThrow();
  });

  it('subscribes to nothing without a document', () => {
    expect(() => onWebFontsSettled(jest.fn())()).not.toThrow();
  });

  it('subscribes to nothing on native', () => {
    Platform.OS = 'ios';
    const fonts = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    (globalThis as { document?: unknown }).document = { fonts };
    onWebFontsSettled(jest.fn())();
    expect(fonts.addEventListener).not.toHaveBeenCalled();
  });
});
