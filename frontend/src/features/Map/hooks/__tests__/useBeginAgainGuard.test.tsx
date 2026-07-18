/**
 * Regression test for useBeginAgainGuard:
 * ensures no state update on unmounted component (warning about worker failed to exit gracefully).
 */

import React from 'react';
import { render, act, cleanup } from '@testing-library/react-native';
import { useBeginAgainGuard } from '../useBeginAgainGuard';
import { stageService } from '../../services/stageService';

jest.mock('../../services/stageService');

const createDeferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve: resolve! };
};

describe('useBeginAgainGuard', () => {
  afterEach(() => {
    jest.clearAllMocks();
    cleanup();
  });

  it('should not update state after unmount', async () => {
    const { promise: deferPromise, resolve: deferResolve } = createDeferred();
    (stageService.beginAgain as jest.Mock).mockReturnValue(deferPromise);

    // Spy on console.error to catch warnings about state update on unmounted component
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    let displayed: boolean | null = null;
    let handleBeginAgain: () => void;

    render(() => {
      const { beginning, handleBeginAgain: h } = useBeginAgainGuard();
      displayed = beginning;
      handleAgain = h;
      return null;
    });

    // Trigger beginAgain
    act(() => {
      handleBeginAgain();
    });

    expect(displayed).toBe(true);
    expect(stageService.beginAgain).toHaveBeenCalledTimes(1);

    // Unmount component
    act(() => {
      cleanup();
    });

    // Resolve the deferred promise after unmount
    act(() => {
      deferResolve();
    });

    // Wait for the promise to settle
    await act(async () => {
      await deferPromise;
    });

    // Expect no warning about state update on unmounted component
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('state update on an unmounted component')
    );

    consoleErrorSpy.mockRestore();
  });
});