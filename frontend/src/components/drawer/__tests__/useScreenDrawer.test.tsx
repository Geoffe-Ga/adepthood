import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, renderHook } from '@testing-library/react-native';
import React from 'react';

const mockUseNavigation = jest.fn();
const mockUseRoute = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: (...args: unknown[]) => mockUseNavigation(...args),
  useRoute: (...args: unknown[]) => mockUseRoute(...args),
}));

import { useScreenDrawer } from '@/components/drawer/useScreenDrawer';

interface HeaderLeftOptions {
  headerLeft: (() => React.ReactElement) | undefined;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('useScreenDrawer', () => {
  it('installs a headerLeft render option on mount', () => {
    const mockSetOptions = jest.fn();
    mockUseNavigation.mockReturnValue({ setOptions: mockSetOptions });

    renderHook(() => useScreenDrawer('Habits'));

    expect(mockSetOptions).toHaveBeenCalled();
    const firstCall = mockSetOptions.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('expected a setOptions call');
    }
    const firstCallOptions = firstCall[0] as HeaderLeftOptions;
    expect(typeof firstCallOptions.headerLeft).toBe('function');
  });

  it('renders a valid element from the headerLeft factory', () => {
    const mockSetOptions = jest.fn();
    mockUseNavigation.mockReturnValue({ setOptions: mockSetOptions });

    renderHook(() => useScreenDrawer('Habits'));

    const firstCall = mockSetOptions.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('expected a setOptions call');
    }
    const firstCallOptions = firstCall[0] as HeaderLeftOptions;
    const headerLeft = firstCallOptions.headerLeft;
    if (headerLeft === undefined) {
      throw new Error('headerLeft was not installed');
    }
    expect(React.isValidElement(headerLeft())).toBe(true);
  });

  it('starts closed and flips isOpen between open() and close()', () => {
    const mockSetOptions = jest.fn();
    mockUseNavigation.mockReturnValue({ setOptions: mockSetOptions });

    const { result } = renderHook(() => useScreenDrawer('Habits'));
    expect(result.current.isOpen).toBe(false);

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });
    expect(result.current.isOpen).toBe(false);
  });

  it('shows the toggle as expanded once the drawer is opened', () => {
    const mockSetOptions = jest.fn();
    mockUseNavigation.mockReturnValue({ setOptions: mockSetOptions });

    const { result } = renderHook(() => useScreenDrawer('Journal'));

    act(() => {
      result.current.open();
    });

    const calls = mockSetOptions.mock.calls;
    const lastCall = calls[calls.length - 1];
    if (lastCall === undefined) {
      throw new Error('expected a setOptions call');
    }
    const lastCallOptions = lastCall[0] as HeaderLeftOptions;
    const headerLeft = lastCallOptions.headerLeft;
    if (headerLeft === undefined) {
      throw new Error('headerLeft was not installed');
    }
    const { getByTestId } = render(headerLeft());

    expect(getByTestId('drawer-toggle').props.accessibilityState).toEqual({ expanded: true });
  });

  it('resets headerLeft to undefined on unmount', () => {
    const mockSetOptions = jest.fn();
    mockUseNavigation.mockReturnValue({ setOptions: mockSetOptions });

    const { unmount } = renderHook(() => useScreenDrawer('Habits'));
    const callsBeforeUnmount = mockSetOptions.mock.calls.length;

    unmount();

    const calls = mockSetOptions.mock.calls;
    expect(calls.length).toBeGreaterThan(callsBeforeUnmount);
    const lastCall = calls[calls.length - 1];
    if (lastCall === undefined) {
      throw new Error('expected a setOptions call');
    }
    const lastCallOptions = lastCall[0] as HeaderLeftOptions;
    expect(lastCallOptions.headerLeft).toBeUndefined();
  });
});
