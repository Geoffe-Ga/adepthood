import { describe, expect, it, jest } from '@jest/globals';

import { revealMarginTarget } from '../marginNavigationScroll';
import type { MarginNavigationScroller } from '../marginNavigationScroll';
function setup(targetTop: number | null, scrollTop = 200) {
  const listeners = new Map<string, () => void>();
  const scroll: MarginNavigationScroller = {
    scrollTop,
    scrollHeight: 5000,
    clientHeight: 700,
    getBoundingClientRect: () => ({ top: 100 }),
    scroll: jest.fn((options: { top: number; behavior: 'auto' | 'smooth' }) => {
      if (options.behavior === 'auto') scroll.scrollTop = options.top;
    }),
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type) => {
      listeners.delete(type);
    },
  };
  const root = {
    querySelector: () =>
      targetTop == null ? null : { getBoundingClientRect: () => ({ top: targetTop }) },
  };
  return { root, scroll, listeners };
}
describe('deliberate passage / margin navigation', () => {
  it('moves only the page scroller and opens after the smooth scroll settles', () => {
    const { root, scroll, listeners } = setup(2500);
    const opened = jest.fn();
    revealMarginTarget(root, scroll, 'margin-note-3', false, opened);
    expect(scroll.scroll).toHaveBeenCalledWith({ top: 2580, behavior: 'smooth' });
    expect(opened).not.toHaveBeenCalled();
    scroll.scrollTop = 2580;
    listeners.get('scrollend')?.();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
  it('jumps under reduced motion without waiting for an event that may never fire', () => {
    const { root, scroll } = setup(-1000);
    const reached = jest.fn();
    revealMarginTarget(root, scroll, 'highlight-3', true, reached);
    expect(scroll.scroll).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(reached).toHaveBeenCalledTimes(1);
  });
  it('cancels old continuations after a new selection or page change', () => {
    const { root, scroll, listeners } = setup(2500);
    const opened = jest.fn();
    const cancel = revealMarginTarget(root, scroll, 'margin-note-3', false, opened);
    const oldEvent = listeners.get('scrollend');
    cancel?.();
    oldEvent?.();
    expect(opened).not.toHaveBeenCalled();
  });
  it.each([null, Number.NaN])('does not scroll or open a missing / invalid anchor: %p', (top) => {
    const { root, scroll } = setup(top);
    const opened = jest.fn();
    expect(revealMarginTarget(root, scroll, 'highlight-3', false, opened)).toBeNull();
    expect(scroll.scroll).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });
  it('clamps a note below the page bottom and completes an already-settled jump', () => {
    const { root, scroll, listeners } = setup(9000, 4300);
    const reached = jest.fn();
    revealMarginTarget(root, scroll, 'margin-note-3', false, reached);
    expect(scroll.scroll).toHaveBeenCalledWith({ top: 4300, behavior: 'auto' });
    expect(reached).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

it('does not open a note when a person interrupts smooth scrolling before the target', () => {
  const { root, scroll, listeners } = setup(2500);
  const opened = jest.fn();
  revealMarginTarget(root, scroll, 'margin-note-3', false, opened);
  scroll.scrollTop = 600;
  listeners.get('scrollend')?.();
  expect(opened).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});
