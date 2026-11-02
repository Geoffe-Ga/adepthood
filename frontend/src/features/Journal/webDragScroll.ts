/**
 * Click-and-drag scrolling for a horizontal strip on web.
 *
 * A finger already swipes a horizontal ScrollView, and a trackpad pans it, but
 * a mouse has no gesture for sideways scrolling short of Shift+wheel, which few
 * writers know. So on web a primary-button mouse drag pans the strip the way a
 * finger would. Touch and pen are left to the browser's own swipe.
 *
 * A drag that ends over a button must not also press it: react-native-web runs
 * a Pressable's onPress from the DOM ``click`` (``PressResponder.onClick``), so
 * the click that closes a drag is stopped in the capture phase, before it
 * reaches the button.
 */
import { useEffect, type RefObject } from 'react';
import { Platform, type ScrollView } from 'react-native';

/** How far (px) the mouse travels before a press becomes a drag; less is a click. */
export const DRAG_SCROLL_THRESHOLD = 4;

const PRIMARY_BUTTON = 0;

/** The parts of a pointer or mouse event this reads (a DOM PointerEvent fits). */
interface DragPointerEvent {
  pointerType?: string;
  button?: number;
  clientX?: number;
  pointerId?: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

type DragListener = (event: DragPointerEvent) => void;

/** The parts of the scroll container's DOM node this drives (an HTMLElement fits). */
export interface DragScrollNode {
  scrollLeft: number;
  addEventListener: (type: string, listener: DragListener, capture?: boolean) => void;
  removeEventListener: (type: string, listener: DragListener, capture?: boolean) => void;
  setPointerCapture?: (pointerId: number) => void;
}

function isDragScrollNode(node: unknown): node is DragScrollNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    'scrollLeft' in node &&
    'addEventListener' in node &&
    'removeEventListener' in node
  );
}

/** Wire mouse drag-to-scroll onto a scroll container; returns the detach. */
export function attachMouseDragScroll(node: DragScrollNode): () => void {
  let origin: { x: number; scrollLeft: number } | null = null;
  let dragging = false;
  let swallowClick = false;

  const down: DragListener = (event) => {
    if (event.pointerType !== 'mouse' || event.button !== PRIMARY_BUTTON) return;
    origin = { x: event.clientX ?? 0, scrollLeft: node.scrollLeft };
    dragging = false;
    swallowClick = false;
  };
  const move: DragListener = (event) => {
    if (origin == null) return;
    const dx = (event.clientX ?? origin.x) - origin.x;
    if (!dragging) {
      if (Math.abs(dx) < DRAG_SCROLL_THRESHOLD) return;
      dragging = true;
      if (event.pointerId != null) node.setPointerCapture?.(event.pointerId);
    }
    node.scrollLeft = origin.scrollLeft - dx;
  };
  const end: DragListener = () => {
    swallowClick = dragging;
    origin = null;
    dragging = false;
  };
  const click: DragListener = (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const bindings: [string, DragListener, boolean][] = [
    ['pointerdown', down, false],
    ['pointermove', move, false],
    ['pointerup', end, false],
    ['pointercancel', end, false],
    ['click', click, true],
  ];
  for (const [type, listener, capture] of bindings) {
    node.addEventListener(type, listener, capture);
  }
  return () => {
    for (const [type, listener, capture] of bindings) {
      node.removeEventListener(type, listener, capture);
    }
  };
}

/** Give a horizontal ScrollView mouse drag-to-scroll on web; a no-op on native. */
export function useWebDragScroll(scrollRef: RefObject<ScrollView | null>): void {
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node: unknown = scrollRef.current?.getScrollableNode();
    if (!isDragScrollNode(node)) return undefined;
    return attachMouseDragScroll(node);
  }, [scrollRef]);
}
