/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';

import type { AnchorSpan } from '../anchorSpan';
import { letterSourceSpan, type RenderedSelection } from '../renderedSelection';
import {
  clearRenderedSelection,
  useHighlightedPassage,
  useRenderedSelection,
} from '../useRenderedSelection';

/**
 * ``useRenderedSelection`` (#3661): the document's selection over a
 * container's rendered text, as a source span, on the web only. The document,
 * its selection and the layout the in-view check reads are hand-built fakes
 * (this suite runs without a DOM); the mapping itself is pinned in
 * ``renderedSelection.test.ts``.
 */

const Platform = require('react-native').Platform as { OS: string };

const ESSAY = 'Stay with it. Come back to it.';
const VIEWPORT_HEIGHT = 800;
/** The scroller the container is drawn in: the top half of the screen. */
const SCROLLER_BAND = { top: 0, bottom: 400 };

interface Rect {
  top: number;
  bottom: number;
}

interface FakeElement {
  nodeType: number;
  nodeValue: null;
  childNodes: unknown[];
  getAttribute: () => null;
  parentElement: FakeElement | null;
  getBoundingClientRect: () => Rect;
}

interface FakeRange {
  startContainer: unknown;
  startOffset: number;
  endContainer: unknown;
  endOffset: number;
  getBoundingClientRect: () => Rect;
}

const essayNode = { nodeType: 3, nodeValue: ESSAY, childNodes: [] };
const outsideNode = { nodeType: 3, nodeValue: 'elsewhere', childNodes: [] };
const scroller: FakeElement = {
  nodeType: 1,
  nodeValue: null,
  childNodes: [],
  getAttribute: () => null,
  parentElement: null,
  getBoundingClientRect: () => SCROLLER_BAND,
};
const container: FakeElement = {
  nodeType: 1,
  nodeValue: null,
  childNodes: [essayNode],
  getAttribute: () => null,
  parentElement: scroller,
  getBoundingClientRect: () => ({ top: 0, bottom: 300 }),
};

/** The fake page: one selection, one range, and where that range is drawn. */
const page = {
  rangeCount: 1,
  isCollapsed: false,
  range: null as FakeRange | null,
  rect: { top: 100, bottom: 120 } as Rect,
  hasView: true,
};

const removeAllRanges = jest.fn();

function rangeOver(text: string, node: unknown = essayNode): FakeRange {
  const start = ESSAY.indexOf(text);
  return {
    startContainer: node,
    startOffset: Math.max(start, 0),
    endContainer: node,
    endOffset: Math.max(start, 0) + text.length,
    getBoundingClientRect: () => page.rect,
  };
}

function makeDocument(): EventTarget {
  const view = {
    innerHeight: VIEWPORT_HEIGHT,
    getComputedStyle: (element: unknown) => ({
      overflowY: element === scroller ? 'auto' : 'visible',
    }),
  };
  const doc = Object.assign(new EventTarget(), {
    getSelection: () => ({
      rangeCount: page.rangeCount,
      isCollapsed: page.isCollapsed,
      getRangeAt: () => page.range,
      removeAllRanges,
    }),
  });
  // A getter, read when the hook measures: Object.assign would copy its value once.
  Object.defineProperty(doc, 'defaultView', { get: () => (page.hasView ? view : null) });
  return doc;
}

interface MutableGlobal {
  document?: unknown;
}

const toLetterSpan = (selection: RenderedSelection): AnchorSpan | null =>
  letterSourceSpan(ESSAY, selection);

function Harness({
  target,
  map = toLetterSpan,
  onSpan,
}: {
  target: unknown;
  map?: (_selection: RenderedSelection) => AnchorSpan | null;
  onSpan: (_span: AnchorSpan | null) => void;
}): null {
  const ref = React.useRef<unknown>(target);
  onSpan(useRenderedSelection(ref, map));
  return null;
}

function mount(target: unknown = container, map = toLetterSpan) {
  const seen: (AnchorSpan | null)[] = [];
  const view = render(<Harness target={target} map={map} onSpan={(span) => seen.push(span)} />);
  return { seen, latest: () => seen.at(-1) ?? null, unmount: view.unmount };
}

function fire(type: 'selectionchange' | 'scroll'): void {
  act(() => {
    ((globalThis as MutableGlobal).document as EventTarget).dispatchEvent(new Event(type));
  });
}

describe('useRenderedSelection', () => {
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    (globalThis as MutableGlobal).document = makeDocument();
    Object.assign(page, {
      rangeCount: 1,
      isCollapsed: false,
      range: rangeOver('Come back'),
      rect: { top: 100, bottom: 120 },
      hasView: true,
    });
    removeAllRanges.mockClear();
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete (globalThis as MutableGlobal).document;
  });

  it('reads a selection already there when it mounts', () => {
    const { latest } = mount();
    expect(latest()).toEqual({ start: 14, end: 23 });
  });

  it('emits the source span when the reader selects inside the container', () => {
    page.range = rangeOver('Stay with it.');
    const { latest } = mount();
    page.range = rangeOver('Come back to it.');
    fire('selectionchange');
    expect(latest()).toEqual({ start: 14, end: 30 });
  });

  it('emits null once the selection collapses, or there is none', () => {
    const { latest } = mount();
    page.isCollapsed = true;
    fire('selectionchange');
    expect(latest()).toBeNull();
    page.isCollapsed = false;
    page.rangeCount = 0;
    fire('selectionchange');
    expect(latest()).toBeNull();
  });

  it('emits null for a selection that reaches outside the container', () => {
    const { latest } = mount();
    page.range = { ...rangeOver('Stay'), endContainer: outsideNode };
    fire('selectionchange');
    expect(latest()).toBeNull();
  });

  it('emits null when the mapper finds no source under the selection', () => {
    const { latest } = mount(container, () => null);
    expect(latest()).toBeNull();
  });

  it('withdraws while the reader scrolls the selection out of view, and returns with it', () => {
    const { latest } = mount();
    page.rect = { top: SCROLLER_BAND.bottom + 10, bottom: SCROLLER_BAND.bottom + 30 };
    fire('scroll');
    expect(latest()).toBeNull();
    page.rect = { top: -40, bottom: -10 };
    fire('scroll');
    expect(latest()).toBeNull();
    page.rect = { top: 200, bottom: 220 };
    fire('scroll');
    expect(latest()).toEqual({ start: 14, end: 23 });
  });

  it('treats the selection as in view when the document has no window to measure against', () => {
    page.hasView = false;
    page.rect = { top: 5000, bottom: 5020 };
    const { latest } = mount();
    expect(latest()).toEqual({ start: 14, end: 23 });
  });

  it('keeps the same span object while the selection does not change', () => {
    const { seen } = mount();
    const first = seen.at(-1);
    fire('selectionchange');
    fire('scroll');
    expect(seen.at(-1)).toBe(first);
  });

  it('emits null when the container is not a laid-out element', () => {
    expect(mount(null).latest()).toBeNull();
    expect(mount({ nodeType: 3 }).latest()).toBeNull();
  });

  it('never reads a selection off the web', () => {
    Platform.OS = 'ios';
    const { latest } = mount();
    fire('selectionchange');
    expect(latest()).toBeNull();
  });

  it('is a no-op on the web when the DOM is unavailable', () => {
    delete (globalThis as MutableGlobal).document;
    expect(mount().latest()).toBeNull();
  });

  it('stops listening once unmounted', () => {
    const { seen, unmount } = mount();
    const count = seen.length;
    unmount();
    page.range = rangeOver('Stay');
    fire('selectionchange');
    fire('scroll');
    expect(seen).toHaveLength(count);
  });
});

describe('useHighlightedPassage', () => {
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    (globalThis as MutableGlobal).document = makeDocument();
    Object.assign(page, { rangeCount: 1, isCollapsed: false, range: rangeOver('Come back') });
    page.rect = { top: 100, bottom: 120 };
    page.hasView = true;
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete (globalThis as MutableGlobal).document;
  });

  it('maps the highlighted passage back to the source with the renderer’s own mapper', () => {
    let seen: AnchorSpan | null = null;
    function Passage(): null {
      const ref = React.useRef<unknown>(container);
      seen = useHighlightedPassage(ref, ESSAY, letterSourceSpan);
      return null;
    }
    render(<Passage />);
    expect(seen).toEqual({ start: 14, end: 23 });
  });
});

describe('clearRenderedSelection', () => {
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
    (globalThis as MutableGlobal).document = makeDocument();
    removeAllRanges.mockClear();
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete (globalThis as MutableGlobal).document;
  });

  it('lets go of the document selection on the web', () => {
    Platform.OS = 'web';
    clearRenderedSelection();
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });

  it('does nothing off the web, or without a DOM', () => {
    Platform.OS = 'ios';
    clearRenderedSelection();
    Platform.OS = 'web';
    delete (globalThis as MutableGlobal).document;
    expect(() => clearRenderedSelection()).not.toThrow();
    expect(removeAllRanges).not.toHaveBeenCalled();
  });
});
