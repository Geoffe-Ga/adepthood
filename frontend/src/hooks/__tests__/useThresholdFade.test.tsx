/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { motion } from '@/design/tokens';
import * as reducedMotion from '@/hooks/useReducedMotion';
import { FADE_COVER_LIFETIME_MS, useThresholdFade } from '@/hooks/useThresholdFade';

// Flipped off to reproduce the web build where the screen never receives a
// focus event, so the focus effect body never runs at all.
const mockFocusRuns = { current: true };

// useFocusEffect is stubbed to run the callback on mount and its cleanup on
// unmount, mirroring the PracticeScreen test harness.
jest.mock('@react-navigation/native', () => {
  const reactMod = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    ...(jest.requireActual('@react-navigation/native') as object),
    useFocusEffect: (cb: () => void | (() => void)) => {
      reactMod.useEffect(() => {
        if (!mockFocusRuns.current) return undefined;
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
      }, [cb]);
    },
  };
});

/** Read an Animated node's current JS value (``__getValue`` is internal/untyped). */
const animatedValue = (node: Animated.Value): number =>
  (node as unknown as { __getValue: () => number }).__getValue();

const stubAnimation = (): { start: jest.Mock; stop: jest.Mock } => ({
  start: jest.fn(),
  stop: jest.fn(),
});

const stubTiming = (
  animation: ReturnType<typeof stubAnimation>,
): jest.SpiedFunction<typeof Animated.timing> =>
  jest
    .spyOn(Animated, 'timing')
    .mockReturnValue(animation as unknown as Animated.CompositeAnimation);

describe('useThresholdFade', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    mockFocusRuns.current = true;
  });

  it('clears the light cover by the cover lifetime even when the fade never advances a frame', () => {
    jest.useFakeTimers();
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const timing = stubTiming(stubAnimation());

    const { result } = renderHook(() => useThresholdFade());

    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing).toHaveBeenCalledWith(
      result.current.overlayOpacity,
      expect.objectContaining({ toValue: 0, duration: motion.threshold, useNativeDriver: true }),
    );
    expect(animatedValue(result.current.overlayOpacity)).toBe(1);

    act(() => {
      jest.advanceTimersByTime(FADE_COVER_LIFETIME_MS);
    });

    expect(animatedValue(result.current.overlayOpacity)).toBe(0);
    // The floor must outlast the fade it backstops, never cut it short.
    expect(FADE_COVER_LIFETIME_MS).toBeGreaterThan(motion.threshold);
  });

  it('clears the light cover by the cover lifetime when focus never fires', () => {
    jest.useFakeTimers();
    mockFocusRuns.current = false;
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const timing = stubTiming(stubAnimation());

    const { result } = renderHook(() => useThresholdFade());

    expect(timing).not.toHaveBeenCalled();
    expect(animatedValue(result.current.overlayOpacity)).toBe(1);

    act(() => {
      jest.advanceTimersByTime(FADE_COVER_LIFETIME_MS);
    });

    expect(animatedValue(result.current.overlayOpacity)).toBe(0);
  });

  it('skips the fade entirely under reduced motion (overlay rests transparent)', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const timing = stubTiming(stubAnimation());

    const { result } = renderHook(() => useThresholdFade());

    expect(timing).not.toHaveBeenCalled();
    expect(animatedValue(result.current.overlayOpacity)).toBe(0);
  });

  it('stops the running fade and leaves no timer pending when the hook unmounts', () => {
    jest.useFakeTimers();
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const animation = stubAnimation();
    stubTiming(animation);

    const { unmount } = renderHook(() => useThresholdFade());
    unmount();

    expect(animation.stop).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
