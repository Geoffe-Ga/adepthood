/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { SEED_LEAVE_BROWSER_WARNING } from '../seedCopy';
import { useUnloadWarning } from '../useUnloadWarning';

/**
 * #3772: the queue outlives the Seed screen, so in-app navigation asks nothing.
 * Closing or reloading the tab is the one exit that does stop it, and on the
 * web the page warns before that while anything is going over.
 */

/** A window stand-in: the node test environment has none, exactly like a device. */
interface FakeWindow {
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
}

interface MutableGlobal {
  window?: Window & typeof globalThis;
}

const globalRef = globalThis as MutableGlobal;
let originalOS: typeof Platform.OS;

function setPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function fakeWindow(): FakeWindow {
  const view: FakeWindow = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
  globalRef.window = view as unknown as Window & typeof globalThis;
  return view;
}

beforeEach(() => {
  originalOS = Platform.OS;
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  delete globalRef.window;
});

describe('closing the tab while the queue is going over', () => {
  test('warns before a reload while the queue is going over', () => {
    setPlatform('web');
    const view = fakeWindow();

    renderHook(() => useUnloadWarning(true));

    expect(view.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  test('the warning it hands the browser says what closing costs', () => {
    setPlatform('web');
    const view = fakeWindow();
    renderHook(() => useUnloadWarning(true));
    const handler = view.addEventListener.mock.calls[0]?.[1] as (_event: unknown) => void;
    const event = { preventDefault: jest.fn(), returnValue: '' };

    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe(SEED_LEAVE_BROWSER_WARNING);
  });

  test('lets go of the browser once the queue drains', () => {
    setPlatform('web');
    const view = fakeWindow();
    const { rerender } = renderHook<void, { active: boolean }>(
      ({ active }) => useUnloadWarning(active),
      { initialProps: { active: true } },
    );

    rerender({ active: false });

    expect(view.removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  test('asks nothing of a platform that is not the browser', () => {
    setPlatform('ios');
    const view = fakeWindow();

    renderHook(() => useUnloadWarning(true));

    expect(view.addEventListener).not.toHaveBeenCalled();
  });

  test('an idle queue holds nothing back', () => {
    setPlatform('web');
    const view = fakeWindow();

    renderHook(() => useUnloadWarning(false));

    expect(view.addEventListener).not.toHaveBeenCalled();
  });

  test('no window, no listener -- a device is not a page that can be reloaded', () => {
    setPlatform('web');

    expect(() => renderHook(() => useUnloadWarning(true))).not.toThrow();
  });
});
