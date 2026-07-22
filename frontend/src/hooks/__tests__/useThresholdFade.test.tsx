/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { motion } from '@/design/tokens';
import * as reducedMotion from '@/hooks/useReducedMotion';
import { useThresholdFade } from '@/hooks/useThresholdFade';

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
  });

  it('resets to the light ground and schedules the threshold fade when motion is allowed', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const timing = stubTiming(stubAnimation());

    const { result } = renderHook(() => useThresholdFade());

    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing).toHaveBeenCalledWith(
      result.current.overlayOpacity,
      expect.objectContaining({ toValue: 0, duration: motion.threshold, useNativeDriver: true }),
    );
    // The stub runs no frames, so the value holds the reset-to-opaque light ground.
    expect(animatedValue(result.current.overlayOpacity)).toBe(1);
  });

  it('skips the fade entirely under reduced motion (overlay rests transparent)', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const timing = stubTiming(stubAnimation());

    const { result } = renderHook(() => useThresholdFade());

    expect(timing).not.toHaveBeenCalled();
    expect(animatedValue(result.current.overlayOpacity)).toBe(0);
  });

  it('stops the running fade when the focus effect cleans up', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const animation = stubAnimation();
    stubTiming(animation);

    const { unmount } = renderHook(() => useThresholdFade());
    unmount();

    expect(animation.stop).toHaveBeenCalledTimes(1);
  });
});
