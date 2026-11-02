/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';

import {
  DRAG_SCROLL_THRESHOLD,
  attachMouseDragScroll,
  type DragScrollNode,
} from '../webDragScroll';

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  pointerType?: string;
  button?: number;
  clientX?: number;
  pointerId?: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/** A scroll container that records its listeners so a test can dispatch to them. */
function fakeNode() {
  const listeners = new Map<string, Listener[]>();
  const node: DragScrollNode & { captured: number[] } = {
    scrollLeft: 0,
    captured: [],
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    setPointerCapture: (id: number) => {
      node.captured.push(id);
    },
  } as unknown as DragScrollNode & { captured: number[] };
  const fire = (type: string, init: Partial<FakeEvent> = {}) => {
    const event: FakeEvent = {
      pointerType: 'mouse',
      button: 0,
      pointerId: 1,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      ...init,
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    return event;
  };
  return { node, fire, listeners };
}

describe('attachMouseDragScroll', () => {
  it('scrolls the container opposite to a mouse drag, like grabbing the strip', () => {
    const { node, fire } = fakeNode();
    node.scrollLeft = 40;
    attachMouseDragScroll(node);
    fire('pointerdown', { clientX: 200 });
    fire('pointermove', { clientX: 150 });
    expect(node.scrollLeft).toBe(90);
    fire('pointermove', { clientX: 230 });
    expect(node.scrollLeft).toBe(10);
  });

  it('ignores jitter under the threshold, so an ordinary click still presses', () => {
    const { node, fire } = fakeNode();
    attachMouseDragScroll(node);
    fire('pointerdown', { clientX: 100 });
    fire('pointermove', { clientX: 100 - (DRAG_SCROLL_THRESHOLD - 1) });
    fire('pointerup', { clientX: 100 - (DRAG_SCROLL_THRESHOLD - 1) });
    expect(node.scrollLeft).toBe(0);
    const click = fire('click');
    expect(click.stopPropagation).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it('swallows the click that ends a drag, so releasing over a button does not press it', () => {
    const { node, fire } = fakeNode();
    attachMouseDragScroll(node);
    fire('pointerdown', { clientX: 100 });
    fire('pointermove', { clientX: 60 });
    fire('pointerup', { clientX: 60 });
    const click = fire('click');
    expect(click.stopPropagation).toHaveBeenCalled();
    expect(click.preventDefault).toHaveBeenCalled();
    // Only that one click: the next is an ordinary press again.
    const next = fire('click');
    expect(next.stopPropagation).not.toHaveBeenCalled();
  });

  it('captures the pointer once a drag starts, so the strip follows the mouse off it', () => {
    const { node, fire } = fakeNode();
    attachMouseDragScroll(node);
    fire('pointerdown', { clientX: 100, pointerId: 7 });
    expect(node.captured).toEqual([]);
    fire('pointermove', { clientX: 50, pointerId: 7 });
    expect(node.captured).toEqual([7]);
  });

  it('leaves touch and pen to the native swipe scroll', () => {
    const { node, fire } = fakeNode();
    attachMouseDragScroll(node);
    for (const pointerType of ['touch', 'pen']) {
      fire('pointerdown', { clientX: 100, pointerType });
      fire('pointermove', { clientX: 20, pointerType });
    }
    expect(node.scrollLeft).toBe(0);
  });

  it('starts only on the primary button', () => {
    const { node, fire } = fakeNode();
    attachMouseDragScroll(node);
    fire('pointerdown', { clientX: 100, button: 2 });
    fire('pointermove', { clientX: 20 });
    expect(node.scrollLeft).toBe(0);
  });

  it('stops following the mouse after release or cancel', () => {
    const { node, fire } = fakeNode();
    attachMouseDragScroll(node);
    for (const end of ['pointerup', 'pointercancel']) {
      node.scrollLeft = 0;
      fire('pointerdown', { clientX: 100 });
      fire('pointermove', { clientX: 80 });
      fire(end);
      fire('pointermove', { clientX: 0 });
      expect(node.scrollLeft).toBe(20);
    }
  });

  it('removes every listener it added on detach', () => {
    const { node, listeners } = fakeNode();
    const detach = attachMouseDragScroll(node);
    expect([...listeners.values()].flat().length).toBeGreaterThan(0);
    detach();
    expect([...listeners.values()].flat()).toHaveLength(0);
  });
});
