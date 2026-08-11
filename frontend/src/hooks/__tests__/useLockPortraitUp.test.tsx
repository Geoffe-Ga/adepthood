/* eslint-env jest */
import type { jest } from '@jest/globals';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Platform } from 'react-native';

import { useLockPortraitUp } from '../useLockPortraitUp';

const mockLockAsync = ScreenOrientation.lockAsync as jest.MockedFunction<
  (lock: number) => Promise<void>
>;

let originalOS: typeof Platform.OS;

beforeEach(() => {
  originalOS = Platform.OS;
  mockLockAsync.mockReset();
  mockLockAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
});

function setPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

describe('useLockPortraitUp', () => {
  it('locks to PORTRAIT_UP on mount', async () => {
    setPlatform('ios');
    renderHook(() => useLockPortraitUp());

    await waitFor(() => expect(mockLockAsync).toHaveBeenCalledTimes(1));
    // PORTRAIT_UP, not PORTRAIT: the report asks for the top of the device held
    // vertically to always be the top of the UI, and plain PORTRAIT still
    // permits upside-down on some hardware.
    expect(mockLockAsync).toHaveBeenCalledWith(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  });

  it('locks on Android too', async () => {
    setPlatform('android');
    renderHook(() => useLockPortraitUp());

    await waitFor(() => expect(mockLockAsync).toHaveBeenCalledTimes(1));
    expect(mockLockAsync).toHaveBeenCalledWith(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  });

  it('does not attempt to lock on web', () => {
    // The browser Screen Orientation API rejects outside fullscreen, and this
    // app ships to production on the web. Calling it there buys nothing and
    // costs an error on every load.
    setPlatform('web');
    renderHook(() => useLockPortraitUp());

    expect(mockLockAsync).not.toHaveBeenCalled();
  });

  it('survives a rejected lock instead of crashing the app', async () => {
    // Simulators, unusual OEM builds and future SDK changes can all reject.
    // An orientation preference must never be the reason the app fails to
    // start, and an unhandled rejection here would surface as exactly that.
    setPlatform('ios');
    mockLockAsync.mockRejectedValue(new Error('orientation lock unavailable'));

    expect(() => renderHook(() => useLockPortraitUp())).not.toThrow();
    await waitFor(() => expect(mockLockAsync).toHaveBeenCalledTimes(1));
  });

  it('locks once, not on every render', async () => {
    setPlatform('ios');
    const { rerender } = renderHook(() => useLockPortraitUp());
    await waitFor(() => expect(mockLockAsync).toHaveBeenCalledTimes(1));

    rerender({});
    rerender({});

    expect(mockLockAsync).toHaveBeenCalledTimes(1);
  });
});
