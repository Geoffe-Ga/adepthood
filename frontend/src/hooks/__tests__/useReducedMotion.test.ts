/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import type { EmitterSubscription } from 'react-native';

import { useReducedMotion } from '../useReducedMotion';

type ReduceMotionListener = (_value: boolean) => void;
const subscription = { remove: jest.fn() } as unknown as EmitterSubscription;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useReducedMotion', () => {
  it('reflects the initial OS reduce-motion setting', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue(subscription);

    const { result } = renderHook(() => useReducedMotion());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('updates live when the OS setting changes', async () => {
    let fire: ReduceMotionListener | undefined;
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_event, handler) => {
      fire = handler as unknown as ReduceMotionListener;
      return subscription;
    });

    const { result } = renderHook(() => useReducedMotion());
    await waitFor(() => expect(result.current).toBe(false));

    act(() => fire?.(true));
    expect(result.current).toBe(true);
  });
});
