/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';

/**
 * Keeping a chosen passage clear of the floating pill (#3661): once the reader
 * lets go, a passage the pill would cover is scrolled up just clear of it. The
 * document, its selection and its layout are hand-built fakes.
 */
import { RESONANCE_BUTTON_CLEARANCE } from '../JournalEntry.styles';
import { liftNeeded, useLiftClearOfPill } from '../webSelectionLift';

import { SPACING, touchTarget } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

jest.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: jest.fn(() => false) }));

const Platform = require('react-native').Platform as { OS: string };
const mockedReducedMotion = useReducedMotion as jest.MockedFunction<typeof useReducedMotion>;

/** The dock rides the viewport's foot at 800; the pill floats its lift above it. */
const DOCK = { top: 800, bottom: 800 };
const PILL_TOP = DOCK.top - RESONANCE_BUTTON_CLEARANCE - touchTarget.minimum;
const PILL_BOTTOM = DOCK.top - RESONANCE_BUTTON_CLEARANCE;
const VIEWPORT = { top: 60, bottom: 844 };
const BREATH = SPACING.sm;

describe('liftNeeded', () => {
  it('lifts a passage the pill covers until it sits a breath above the pill', () => {
    const passage = { top: PILL_TOP + 4, bottom: PILL_TOP + 24 };
    expect(liftNeeded(passage, DOCK, VIEWPORT)).toBe(24 + BREATH);
  });

  it('lifts a passage whose last line only grazes the pill’s top', () => {
    const passage = { top: PILL_TOP - 40, bottom: PILL_TOP - 2 };
    expect(liftNeeded(passage, DOCK, VIEWPORT)).toBe(BREATH - 2);
  });

  it('leaves a passage already a breath clear above the pill', () => {
    expect(liftNeeded({ top: 100, bottom: PILL_TOP - BREATH }, DOCK, VIEWPORT)).toBe(0);
  });

  it('leaves a passage that lies below the pill, between it and the foot', () => {
    expect(liftNeeded({ top: PILL_BOTTOM, bottom: PILL_BOTTOM + 20 }, DOCK, VIEWPORT)).toBe(0);
  });

  it('never pushes the top of a tall passage out of view to clear its end', () => {
    // It would need 20 + BREATH to clear, but only 10 above it are in view.
    const passage = { top: VIEWPORT.top + 10, bottom: PILL_TOP + 20 };
    expect(liftNeeded(passage, DOCK, VIEWPORT)).toBe(10);
    expect(liftNeeded({ top: VIEWPORT.top - 5, bottom: PILL_TOP + 20 }, DOCK, VIEWPORT)).toBe(0);
  });
});

interface Rect {
  top: number;
  bottom: number;
}

const scrollBy = jest.fn();
const page = { passage: { top: PILL_TOP + 4, bottom: PILL_TOP + 24 } as Rect, collapsed: false };

const scroller = {
  parentElement: null,
  scrollHeight: 3000,
  clientHeight: 780,
  getBoundingClientRect: () => VIEWPORT,
  scrollBy,
};
const column = { parentElement: scroller, scrollHeight: 3000, clientHeight: 3000 };
const dock = {
  nodeType: 1,
  parentElement: column,
  getBoundingClientRect: () => DOCK,
};

function makeDocument(): EventTarget {
  const doc = Object.assign(new EventTarget(), {
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: page.collapsed,
      getRangeAt: () => ({ getBoundingClientRect: () => page.passage }),
    }),
    defaultView: {
      getComputedStyle: (node: unknown) => ({ overflowY: node === scroller ? 'auto' : 'visible' }),
    },
  });
  return doc;
}

interface MutableGlobal {
  document?: unknown;
}

const PASSAGE = { start: 10, end: 30 };

function Harness({
  chosen,
  target = dock,
  passage = PASSAGE,
}: {
  chosen: boolean;
  target?: unknown;
  passage?: { start: number; end: number };
}): null {
  const ref = React.useRef<unknown>(target);
  useLiftClearOfPill(ref, chosen ? passage : null);
  return null;
}

function fire(type: string): void {
  act(() => {
    ((globalThis as MutableGlobal).document as EventTarget).dispatchEvent(new Event(type));
  });
}

describe('useLiftClearOfPill', () => {
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    (globalThis as MutableGlobal).document = makeDocument();
    page.passage = { top: PILL_TOP + 4, bottom: PILL_TOP + 24 };
    page.collapsed = false;
    scrollBy.mockReset();
    mockedReducedMotion.mockReturnValue(false);
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete (globalThis as MutableGlobal).document;
  });

  it('lifts a passage chosen without a pointer (the keyboard, or a script) as the pill arrives', () => {
    const { rerender } = render(<Harness chosen={false} />);
    expect(scrollBy).not.toHaveBeenCalled();
    rerender(<Harness chosen />);
    expect(scrollBy).toHaveBeenCalledWith({ top: 24 + BREATH, behavior: 'smooth' });
  });

  it('waits for the reader to let go of a drag, then lifts', () => {
    const { rerender } = render(<Harness chosen={false} />);
    fire('pointerdown');
    rerender(<Harness chosen />);
    expect(scrollBy).not.toHaveBeenCalled();
    fire('pointerup');
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it('lifts a second passage chosen while the pill is already up', () => {
    const { rerender } = render(<Harness chosen />);
    scrollBy.mockReset();
    rerender(<Harness chosen passage={{ start: 40, end: 52 }} />);
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it('lifts again when a keyboard selection settles', () => {
    render(<Harness chosen />);
    scrollBy.mockReset();
    fire('keyup');
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it('moves at once under reduced motion', () => {
    mockedReducedMotion.mockReturnValue(true);
    render(<Harness chosen />);
    expect(scrollBy).toHaveBeenCalledWith({ top: 24 + BREATH, behavior: 'auto' });
  });

  it('does nothing while no passage is chosen, or the pill covers none of it', () => {
    render(<Harness chosen={false} />);
    fire('pointerup');
    expect(scrollBy).not.toHaveBeenCalled();
    page.passage = { top: 100, bottom: 140 };
    render(<Harness chosen />);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does nothing when the selection has gone, or the dock is not laid out', () => {
    page.collapsed = true;
    render(<Harness chosen />);
    page.collapsed = false;
    render(<Harness chosen target={null} />);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does nothing when nothing around the pill scrolls', () => {
    render(<Harness chosen target={{ ...dock, parentElement: null }} />);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('is a no-op off the web, and stops listening once unmounted', () => {
    Platform.OS = 'ios';
    render(<Harness chosen />);
    expect(scrollBy).not.toHaveBeenCalled();
    Platform.OS = 'web';
    const { unmount } = render(<Harness chosen={false} />);
    unmount();
    fire('pointerup');
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
