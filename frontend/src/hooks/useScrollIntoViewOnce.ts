/**
 * Bring one target into view in a ScrollView, once, when a screen is opened on
 * it (#3006: Settings opened on the writing-habit row).
 *
 * Hand ``scrollRef`` to the ScrollView and ``onTargetLayout`` to the target.
 * While ``active``, the first time the target's position is known the view
 * scrolls to it, then latches: a later re-layout (a picker opening beneath
 * it) never pulls the screen back under the writer's thumb. Turning ``active``
 * off re-arms it. A target laid out before ``active`` turned on is scrolled to
 * the moment it does, so an already-mounted screen opened on it still moves.
 *
 * The scroll glides unless the OS asks for reduced motion, when it jumps; it
 * waits for that setting to be known, so a layout that lands first never glides.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

import { useReducedMotionSetting } from '@/hooks/useReducedMotion';

export interface ScrollIntoViewOnce {
  scrollRef: RefObject<ScrollView | null>;
  onTargetLayout: (_event: LayoutChangeEvent) => void;
}

export function useScrollIntoViewOnce(active: boolean): ScrollIntoViewOnce {
  const scrollRef = useRef<ScrollView | null>(null);
  // ``null`` until the OS answers: the scroll waits for it rather than gliding
  // for a writer who asked for none because the layout happened to land first.
  const reducedMotion = useReducedMotionSetting();
  const targetY = useRef<number | null>(null);
  const scrolled = useRef(false);

  const scrollIfReady = useCallback(() => {
    if (!active || scrolled.current || targetY.current === null || reducedMotion === null) return;
    scrolled.current = true;
    scrollRef.current?.scrollTo({ y: targetY.current, animated: !reducedMotion });
  }, [active, reducedMotion]);

  useEffect(() => {
    if (!active) {
      scrolled.current = false;
      return;
    }
    scrollIfReady();
  }, [active, scrollIfReady]);

  const onTargetLayout = useCallback(
    (event: LayoutChangeEvent) => {
      targetY.current = event.nativeEvent.layout.y;
      scrollIfReady();
    },
    [scrollIfReady],
  );

  return { scrollRef, onTargetLayout };
}
