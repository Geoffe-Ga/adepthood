/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { SEED_LEAVE_BROWSER_WARNING } from '../seedCopy';
import { useSeedLeaveGuard, type SeedLeaveGuard } from '../useSeedLeaveGuard';

const mockDispatch = jest.fn();
const mockListeners = new Map<string, (_event: unknown) => void>();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    dispatch: mockDispatch,
    addListener: (name: string, handler: (_event: unknown) => void) => {
      mockListeners.set(name, handler);
      return () => mockListeners.delete(name);
    },
  }),
}));

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

const HELD_ACTION = { type: 'POP' };

function beforeRemoveEvent(): { preventDefault: jest.Mock; data: { action: unknown } } {
  return { preventDefault: jest.fn(), data: { action: HELD_ACTION } };
}

function fireBeforeRemove(event: unknown): void {
  act(() => {
    mockListeners.get('beforeRemove')?.(event);
  });
}

beforeEach(() => {
  originalOS = Platform.OS;
  mockListeners.clear();
  mockDispatch.mockReset();
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  delete globalRef.window;
});

describe('an idle run', () => {
  test('holds nothing back, so an ordinary exit stays ordinary', () => {
    renderHook(() => useSeedLeaveGuard(false, jest.fn()));

    expect(mockListeners.has('beforeRemove')).toBe(false);
  });

  test('stops holding the exit as soon as the run settles', () => {
    const { rerender } = renderHook<SeedLeaveGuard, { active: boolean }>(
      ({ active }) => useSeedLeaveGuard(active, jest.fn()),
      { initialProps: { active: true } },
    );
    expect(mockListeners.has('beforeRemove')).toBe(true);

    rerender({ active: false });

    expect(mockListeners.has('beforeRemove')).toBe(false);
  });
});

describe('a run still going over', () => {
  test('asks first instead of leaving', () => {
    const onLeave = jest.fn();
    const { result } = renderHook(() => useSeedLeaveGuard(true, onLeave));
    const event = beforeRemoveEvent();

    fireBeforeRemove(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.current.isPrompting).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });

  test('staying puts the question away and changes nothing about the run', () => {
    const onLeave = jest.fn();
    const { result } = renderHook(() => useSeedLeaveGuard(true, onLeave));
    fireBeforeRemove(beforeRemoveEvent());

    act(() => {
      result.current.stay();
    });

    expect(result.current.isPrompting).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('leaving stops the run first, then performs the exit it held', () => {
    const order: string[] = [];
    const onLeave = jest.fn(() => order.push('cancelled'));
    mockDispatch.mockImplementation(() => order.push('navigated'));
    const { result } = renderHook(() => useSeedLeaveGuard(true, onLeave));
    fireBeforeRemove(beforeRemoveEvent());

    act(() => {
      result.current.confirmLeave();
    });

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(HELD_ACTION);
    expect(order).toEqual(['cancelled', 'navigated']);
    expect(result.current.isPrompting).toBe(false);
  });

  test('leaving with no exit held stops the run and navigates nowhere', () => {
    // Defensive: the prompt is only on screen once an exit has been held, so
    // this path should be unreachable -- and must still not invent a
    // navigation the person never asked for.
    const onLeave = jest.fn();
    const { result } = renderHook(() => useSeedLeaveGuard(true, onLeave));

    act(() => {
      result.current.confirmLeave();
    });

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('does not ask a second time about the exit it was just told to make', () => {
    const { result } = renderHook(() => useSeedLeaveGuard(true, jest.fn()));
    fireBeforeRemove(beforeRemoveEvent());
    act(() => {
      result.current.confirmLeave();
    });

    const second = beforeRemoveEvent();
    fireBeforeRemove(second);

    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(result.current.isPrompting).toBe(false);
  });
});

describe('the browser, where an exit never reaches the navigator', () => {
  test('warns before a reload while a run is going over', () => {
    setPlatform('web');
    const view = fakeWindow();

    renderHook(() => useSeedLeaveGuard(true, jest.fn()));

    expect(view.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  test('the warning it hands the browser says what leaving costs', () => {
    setPlatform('web');
    const view = fakeWindow();
    renderHook(() => useSeedLeaveGuard(true, jest.fn()));
    const handler = view.addEventListener.mock.calls[0]?.[1] as (_event: unknown) => void;
    const event = { preventDefault: jest.fn(), returnValue: '' };

    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe(SEED_LEAVE_BROWSER_WARNING);
  });

  test('lets go of the browser once the run settles', () => {
    setPlatform('web');
    const view = fakeWindow();
    const { rerender } = renderHook<SeedLeaveGuard, { active: boolean }>(
      ({ active }) => useSeedLeaveGuard(active, jest.fn()),
      { initialProps: { active: true } },
    );

    rerender({ active: false });

    expect(view.removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  test('asks nothing of a platform that is not the browser', () => {
    setPlatform('ios');
    const view = fakeWindow();

    renderHook(() => useSeedLeaveGuard(true, jest.fn()));

    expect(view.addEventListener).not.toHaveBeenCalled();
  });

  test('no window, no listener -- a device is not a page that can be reloaded', () => {
    setPlatform('web');

    expect(() => renderHook(() => useSeedLeaveGuard(true, jest.fn()))).not.toThrow();
  });
});
