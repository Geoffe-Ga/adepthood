import { afterEach, describe, expect, it } from '@jest/globals';
import { Platform } from 'react-native';

import { measureAnchorTops } from '../marginAnchorMeasure';

const STREAM_TOP = 100;
const originalOS = Platform.OS;

function rect(top: number) {
  return { getBoundingClientRect: () => ({ top }) };
}

/**
 * A stand-in for the rendered DOM: the stream's page holds highlight runs by
 * exact ``data-testid``, the way react-native-web writes a ``testID``.
 */
function fakeStream(spans: Record<string, number>, streamTop = STREAM_TOP) {
  const selectors: string[] = [];
  const page = {
    querySelector: (selector: string) => {
      selectors.push(selector);
      const testID = /^\[data-testid="(.+)"\]$/.exec(selector)?.[1];
      const top = testID === undefined ? undefined : spans[testID];
      return top === undefined ? null : rect(top);
    },
  };
  return {
    selectors,
    stream: {
      ...rect(streamTop),
      closest: (selector: string) => (selector === '[data-testid="journal-page"]' ? page : null),
    },
  };
}

function setOS(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

afterEach(() => setOS(originalOS));

describe('measureAnchorTops', () => {
  it('reads each highlight’s top relative to the margin stream on web', () => {
    setOS('web');
    const { stream } = fakeStream({ 'highlight-1': 300, 'highlight-2': 40 });

    const tops = measureAnchorTops(stream, [1, 2]);

    expect([...tops]).toEqual([
      [1, 300 - STREAM_TOP],
      [2, 40 - STREAM_TOP],
    ]);
  });

  it('asks for the primary run by exact testID, never a continuation', () => {
    setOS('web');
    const { stream, selectors } = fakeStream({ 'highlight-1-continuation': 500 });

    expect([...measureAnchorTops(stream, [1])]).toEqual([]);
    expect(selectors).toEqual(['[data-testid="highlight-1"]']);
  });

  it('leaves out a note whose highlight is missing or measures non-finite', () => {
    setOS('web');
    const { stream } = fakeStream({ 'highlight-1': 250, 'highlight-3': Number.NaN });

    expect([...measureAnchorTops(stream, [1, 2, 3])]).toEqual([[1, 250 - STREAM_TOP]]);
  });

  it('measures nothing without a mounted stream, a page, or a DOM node', () => {
    setOS('web');
    const orphan = { ...rect(STREAM_TOP), closest: () => null };

    expect(measureAnchorTops(null, [1]).size).toBe(0);
    expect(measureAnchorTops(orphan, [1]).size).toBe(0);
    expect(measureAnchorTops({ measure: () => undefined }, [1]).size).toBe(0);
  });

  it('measures nothing on native, where the flow layout stays', () => {
    setOS('ios');
    const { stream } = fakeStream({ 'highlight-1': 300 });

    expect(measureAnchorTops(stream, [1]).size).toBe(0);
  });
});
