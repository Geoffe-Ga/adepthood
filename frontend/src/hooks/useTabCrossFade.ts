/**
 * Tab cross-fade — the in-place `Practice | Catalog` flip (#1952).
 *
 * The flip used to be a hard swap: one surface unmounted and the other mounted
 * in the same commit, in both directions, so there was nothing to fade. This
 * keeps the outgoing surface mounted beside the incoming one for the length of
 * one `motion.threshold`, fades it 1 -> 0 while the incoming one fades 0 -> 1,
 * and unmounts it once the incoming fade finishes. Each tab key owns its own
 * `Animated.Value`, so a re-flip mid-fade picks the returning surface up at the
 * opacity it had reached instead of snapping it to 0 and flashing.
 *
 * Like `useThresholdFade`, the flourish fails open. The leaving surface has a
 * bounded lifetime enforced by a plain timer armed before the animation
 * exists, so whether or not the driver ever reports completion, the leaving
 * surface is gone and the incoming one opaque within
 * `TAB_CROSSFADE_LIFETIME_MS`. Completion is honoured only when it reports
 * `finished: true` for the transition still in flight: `stop()` reports
 * `finished: false`, and a generation counter ignores a stale report from a
 * fade a re-flip already replaced. Unmount, a re-flip and a blur all stop the
 * running animation; a blur also settles at once, so a screen left mid-fade
 * comes back at rest.
 *
 * Fully disabled under reduced motion — the incoming surface takes the screen
 * at full opacity in the same commit and no animation is scheduled. Selecting
 * the tab already on show does nothing.
 *
 * The caller hides the leaving surface from assistive tech and from pointers
 * (`decorativeHidden`, `pointerEvents="none"`). One gap is accepted rather
 * than closed: on the web a hidden control can still take keyboard focus, and
 * `a11yHidden` asks callers to take such controls out of the tab order. Nothing
 * in React Native's props removes a subtree from the web tab order, and the
 * window is bounded: the leaving surface is mounted for at most
 * `TAB_CROSSFADE_LIFETIME_MS`, after which its controls are gone outright.
 */
import { useFocusEffect } from '@react-navigation/native';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { useReducedMotion } from './useReducedMotion';

import { motion } from '@/design/tokens';

/** Slack past the fade's own duration before the floor settles it. */
export const TAB_CROSSFADE_GRACE_MS = 200;
/** Upper bound on how long a leaving surface may stay mounted, ever. */
export const TAB_CROSSFADE_LIFETIME_MS = motion.threshold + TAB_CROSSFADE_GRACE_MS;

export interface TabCrossFade<T extends string> {
  /** The tab on show (and taking input) — the incoming one during a fade. */
  tab: T;
  /** The tab fading out, still mounted, or ``null`` at rest. */
  leaving: T | null;
  /** Flip to ``next``; a no-op when it is already on show. */
  select: (next: T) => void;
  /** The opacity driving the surface for ``key``. */
  opacityOf: (key: T) => Animated.Value;
}

interface CrossFadeState<T extends string> {
  tab: T;
  leaving: T | null;
  /** Bumped on every flip, so a stale completion can tell it is stale. */
  gen: number;
}

/** One lazily created opacity per tab key, resting at 1. */
function useLayerValues<T extends string>(): (key: T) => Animated.Value {
  const values = useRef(new Map<T, Animated.Value>());
  return useCallback((key: T) => {
    let value = values.current.get(key);
    if (value === undefined) {
      value = new Animated.Value(1);
      values.current.set(key, value);
    }
    return value;
  }, []);
}

/**
 * The flip state, mirrored in a ref so ``select`` and ``settle`` read the
 * latest value synchronously and stay stable across renders.
 */
function useCrossFadeState<T extends string>(
  initial: T,
): [CrossFadeState<T>, React.RefObject<CrossFadeState<T>>, (next: CrossFadeState<T>) => void] {
  const [state, setState] = useState<CrossFadeState<T>>({ tab: initial, leaving: null, gen: 0 });
  const stateRef = useRef(state);
  const commit = useCallback((next: CrossFadeState<T>) => {
    stateRef.current = next;
    setState(next);
  }, []);
  return [state, stateRef, commit];
}

/** Runs the fade for the transition in ``state``, bounded by the floor. */
function useCrossFadeTransition<T extends string>(
  state: CrossFadeState<T>,
  opacityOf: (key: T) => Animated.Value,
  settle: (gen: number) => void,
): void {
  const { tab, leaving, gen } = state;
  useEffect(() => {
    if (leaving === null) return undefined;
    // Armed before the animations exist, so a fade that never animates is
    // still bounded.
    const floor = setTimeout(() => settle(gen), TAB_CROSSFADE_LIFETIME_MS);
    const out = Animated.timing(opacityOf(leaving), {
      toValue: 0,
      duration: motion.threshold,
      useNativeDriver: true,
    });
    const into = Animated.timing(opacityOf(tab), {
      toValue: 1,
      duration: motion.threshold,
      useNativeDriver: true,
    });
    out.start();
    into.start(({ finished }) => {
      if (finished) settle(gen);
    });
    return () => {
      clearTimeout(floor);
      out.stop();
      into.stop();
    };
  }, [tab, leaving, gen, opacityOf, settle]);
}

export function useTabCrossFade<T extends string>(initial: T): TabCrossFade<T> {
  const reduced = useReducedMotion();
  const opacityOf = useLayerValues<T>();
  const [state, stateRef, commit] = useCrossFadeState(initial);

  const settle = useCallback(
    (gen: number) => {
      const current = stateRef.current;
      if (current.gen !== gen || current.leaving === null) return;
      opacityOf(current.tab).setValue(1);
      commit({ ...current, leaving: null });
    },
    [stateRef, opacityOf, commit],
  );

  const select = useCallback(
    (next: T) => {
      const current = stateRef.current;
      if (next === current.tab) return;
      if (reduced) {
        opacityOf(next).setValue(1);
        commit({ tab: next, leaving: null, gen: current.gen + 1 });
        return;
      }
      // A surface coming back mid-leave keeps the opacity it reached.
      if (next !== current.leaving) opacityOf(next).setValue(0);
      commit({ tab: next, leaving: current.tab, gen: current.gen + 1 });
    },
    [reduced, stateRef, opacityOf, commit],
  );

  useCrossFadeTransition(state, opacityOf, settle);

  // Leaving the screen mid-fade settles it. Ref-only, so the callback keeps
  // one identity and a plain re-render never reads as a blur.
  useFocusEffect(useCallback(() => () => settle(stateRef.current.gen), [settle, stateRef]));

  return { tab: state.tab, leaving: state.leaving, select, opacityOf };
}
