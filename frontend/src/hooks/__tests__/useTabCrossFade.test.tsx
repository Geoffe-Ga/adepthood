/* eslint-env jest */
import { jest, describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { motion } from '@/design/tokens';
import * as reducedMotion from '@/hooks/useReducedMotion';
import {
  TAB_CROSSFADE_GRACE_MS,
  TAB_CROSSFADE_LIFETIME_MS,
  useTabCrossFade,
} from '@/hooks/useTabCrossFade';

// Blur is simulated by running the focus callback's cleanup; the stub runs the
// callback on mount and re-runs it whenever its identity changes, exactly as
// the PracticeScreen harness does, so an unstable callback would show up as a
// spurious blur on a plain re-render.
const mockBlurs: Array<() => void> = [];
jest.mock('@react-navigation/native', () => {
  const reactMod = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    ...(jest.requireActual('@react-navigation/native') as object),
    useFocusEffect: (cb: () => void | (() => void)) => {
      reactMod.useEffect(() => {
        const cleanup = cb();
        const blur = (): void => {
          if (typeof cleanup === 'function') cleanup();
        };
        mockBlurs.push(blur);
        return blur;
      }, [cb]);
    },
  };
});

type Tab = 'practice' | 'catalog';

/** Read an Animated node's current JS value (``__getValue`` is internal/untyped). */
const animatedValue = (node: Animated.Value): number =>
  (node as unknown as { __getValue: () => number }).__getValue();

interface CapturedTiming {
  value: Animated.Value;
  config: Animated.TimingAnimationConfig;
  start: jest.Mock<(cb?: Animated.EndCallback) => void>;
  stop: jest.Mock<() => void>;
  /** Report completion the way the driver would. */
  end: (finished: boolean) => void;
}

/** Stub ``Animated.timing`` with animations that never advance on their own. */
function captureTimings(): CapturedTiming[] {
  const calls: CapturedTiming[] = [];
  jest.spyOn(Animated, 'timing').mockImplementation((value, config) => {
    let callback: Animated.EndCallback | undefined;
    const entry: CapturedTiming = {
      value: value as Animated.Value,
      config,
      start: jest.fn((cb?: Animated.EndCallback) => {
        callback = cb;
      }),
      stop: jest.fn(),
      end: (finished) => callback?.({ finished }),
    };
    calls.push(entry);
    return entry as unknown as Animated.CompositeAnimation;
  });
  return calls;
}

function renderCrossFade(initial: Tab = 'practice') {
  return renderHook(() => useTabCrossFade<Tab>(initial));
}

describe('useTabCrossFade', () => {
  beforeEach(() => {
    mockBlurs.length = 0;
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('fades the leaving tab out and the incoming tab in over motion.threshold, then settles', () => {
    const timings = captureTimings();
    const { result } = renderCrossFade();
    const practice = result.current.opacityOf('practice');
    const catalog = result.current.opacityOf('catalog');

    act(() => result.current.select('catalog'));

    expect(result.current.tab).toBe('catalog');
    expect(result.current.leaving).toBe('practice');
    expect(timings).toHaveLength(2);
    const [out, into] = timings;
    expect(out!.value).toBe(practice);
    expect(out!.config).toEqual({ toValue: 0, duration: motion.threshold, useNativeDriver: true });
    expect(into!.value).toBe(catalog);
    expect(into!.config).toEqual({ toValue: 1, duration: motion.threshold, useNativeDriver: true });
    // The incoming surface starts transparent; the leaving one where it was.
    expect(animatedValue(catalog)).toBe(0);
    expect(animatedValue(practice)).toBe(1);
    expect(out!.start).toHaveBeenCalledTimes(1);
    expect(into!.start).toHaveBeenCalledTimes(1);

    act(() => into!.end(true));

    expect(result.current.leaving).toBeNull();
    expect(result.current.tab).toBe('catalog');
    expect(animatedValue(catalog)).toBe(1);
  });

  it('hands each tab key one stable opacity', () => {
    const { result } = renderCrossFade();
    expect(result.current.opacityOf('practice')).toBe(result.current.opacityOf('practice'));
    expect(result.current.opacityOf('practice')).not.toBe(result.current.opacityOf('catalog'));
    expect(animatedValue(result.current.opacityOf('catalog'))).toBe(1);
  });

  it('swaps at once with no animation under reduced motion', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const timings = captureTimings();
    const { result } = renderCrossFade();
    // A surface left transparent by an earlier fade must come back opaque.
    result.current.opacityOf('catalog').setValue(0);

    act(() => result.current.select('catalog'));

    expect(timings).toHaveLength(0);
    expect(result.current.tab).toBe('catalog');
    expect(result.current.leaving).toBeNull();
    expect(animatedValue(result.current.opacityOf('catalog'))).toBe(1);
  });

  it('does nothing when the tab already on show is selected', () => {
    const timings = captureTimings();
    const { result } = renderCrossFade();
    const before = result.current;

    act(() => result.current.select('practice'));

    expect(timings).toHaveLength(0);
    expect(result.current.tab).toBe('practice');
    expect(result.current.leaving).toBeNull();
    expect(result.current.select).toBe(before.select);
    expect(animatedValue(result.current.opacityOf('practice'))).toBe(1);
  });

  it('fails open: the floor settles a fade whose driver never reports, and not a tick sooner', () => {
    jest.useFakeTimers();
    captureTimings();
    const { result } = renderCrossFade();

    act(() => result.current.select('catalog'));
    act(() => {
      jest.advanceTimersByTime(TAB_CROSSFADE_LIFETIME_MS - 1);
    });
    expect(result.current.leaving).toBe('practice');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.leaving).toBeNull();
    expect(animatedValue(result.current.opacityOf('catalog'))).toBe(1);
    // The floor outlasts the fade it backstops, by a named grace.
    expect(TAB_CROSSFADE_LIFETIME_MS).toBe(motion.threshold + TAB_CROSSFADE_GRACE_MS);
  });

  it('a re-flip mid-fade stops the first fade, keeps the returning opacity, and settles on the latest tab', () => {
    const timings = captureTimings();
    const { result } = renderCrossFade();
    const practice = result.current.opacityOf('practice');

    act(() => result.current.select('catalog'));
    const [firstOut, firstInto] = timings;
    // The driver got the leaving surface halfway out before the re-flip.
    practice.setValue(0.5);

    act(() => result.current.select('practice'));

    expect(firstOut!.stop).toHaveBeenCalled();
    expect(firstInto!.stop).toHaveBeenCalled();
    expect(animatedValue(practice)).toBe(0.5);
    expect(result.current.tab).toBe('practice');
    expect(result.current.leaving).toBe('catalog');
    const [secondOut, secondInto] = timings.slice(2);
    expect(secondOut!.value).toBe(result.current.opacityOf('catalog'));
    expect(secondInto!.value).toBe(practice);

    act(() => secondInto!.end(true));
    expect(result.current.tab).toBe('practice');
    expect(result.current.leaving).toBeNull();
  });

  it('unmounting mid-fade stops both animations and leaves no timer behind', () => {
    jest.useFakeTimers();
    const timings = captureTimings();
    const { result, unmount } = renderCrossFade();
    act(() => result.current.select('catalog'));
    expect(jest.getTimerCount()).toBe(1);

    unmount();

    expect(timings[0]!.stop).toHaveBeenCalled();
    expect(timings[1]!.stop).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('settles on blur, and a plain re-render is not a blur', () => {
    const timings = captureTimings();
    const { result, rerender } = renderCrossFade();
    act(() => result.current.select('catalog'));

    rerender({});
    expect(result.current.leaving).toBe('practice');
    expect(mockBlurs).toHaveLength(1);

    act(() => mockBlurs[0]!());

    expect(result.current.leaving).toBeNull();
    expect(result.current.tab).toBe('catalog');
    expect(animatedValue(result.current.opacityOf('catalog'))).toBe(1);
    expect(timings[1]!.stop).toHaveBeenCalled();
  });

  it('a blur at rest changes nothing', () => {
    const { result } = renderCrossFade();
    const before = result.current;
    act(() => mockBlurs[0]!());
    expect(result.current).toBe(before);
  });

  it('ignores a stopped fade and a stale completion from a fade a re-flip replaced', () => {
    const timings = captureTimings();
    const { result } = renderCrossFade();

    act(() => result.current.select('catalog'));
    act(() => timings[1]!.end(false));
    expect(result.current.leaving).toBe('practice');

    act(() => result.current.select('practice'));
    act(() => timings[1]!.end(true));
    expect(result.current.tab).toBe('practice');
    expect(result.current.leaving).toBe('catalog');
  });
});
