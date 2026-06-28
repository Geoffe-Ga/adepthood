/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { PRESS_SCALE, SETTLE_DISTANCE, usePressScale, useSettleIn } from '../motion';

afterEach(() => {
  jest.restoreAllMocks();
});

/** Read an Animated node's current JS value (``__getValue`` is internal/untyped). */
const animatedValue = (node: unknown): number =>
  (node as { __getValue: () => number }).__getValue();

const stubbedTiming = (): jest.SpiedFunction<typeof Animated.timing> =>
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
  } as unknown as Animated.CompositeAnimation);

describe('useSettleIn', () => {
  it('animates the surface in from below when motion is allowed', () => {
    const timing = stubbedTiming();

    const { result } = renderHook(() => useSettleIn(false));

    // Starts below its resting place (translucent, lifted) and schedules a settle.
    expect(animatedValue(result.current.opacity)).toBe(0);
    expect(animatedValue(result.current.transform[0]!.translateY)).toBe(SETTLE_DISTANCE);
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('renders at the resting state with no animation under reduced motion', () => {
    const timing = jest.spyOn(Animated, 'timing');

    const { result } = renderHook(() => useSettleIn(true));

    expect(animatedValue(result.current.opacity)).toBe(1);
    expect(animatedValue(result.current.transform[0]!.translateY)).toBe(0);
    expect(timing).not.toHaveBeenCalled();
  });
});

describe('usePressScale', () => {
  it('drives the press-in / press-out scale when motion is allowed', () => {
    const timing = stubbedTiming();

    const { result } = renderHook(() => usePressScale(false));

    act(() => result.current.onPressIn());
    expect(timing).toHaveBeenLastCalledWith(
      result.current.scale,
      expect.objectContaining({ toValue: PRESS_SCALE, useNativeDriver: true }),
    );

    act(() => result.current.onPressOut());
    expect(timing).toHaveBeenLastCalledWith(
      result.current.scale,
      expect.objectContaining({ toValue: 1, useNativeDriver: true }),
    );
  });

  it('is a no-op under reduced motion (scale stays at rest)', () => {
    const timing = jest.spyOn(Animated, 'timing');

    const { result } = renderHook(() => usePressScale(true));
    act(() => result.current.onPressIn());
    act(() => result.current.onPressOut());

    expect(timing).not.toHaveBeenCalled();
    expect(animatedValue(result.current.scale)).toBe(1);
  });
});
