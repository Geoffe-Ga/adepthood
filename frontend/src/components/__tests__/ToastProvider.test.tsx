/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach, afterEach */

/**
 * Tests for the BUG-FE-UI-105 / -106 fixes in ``ToastProvider``.
 *
 * The provider's contract: bursts of ``showToast`` calls render in
 * order with at least ``TOAST_GAP_MS`` between each, and the gap
 * timer must clear on unmount so a detached provider does not call
 * ``setCurrentToast`` after teardown.
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ToastProvider, useToast } from '../ToastProvider';

function Trigger({ messages }: { messages: string[] }) {
  const { showToast } = useToast();
  React.useEffect(() => {
    for (const message of messages) {
      showToast({ message });
    }
  }, [messages, showToast]);
  return <Text testID="trigger">trigger</Text>;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ToastProvider', () => {
  test('BUG-FE-UI-105: bursting two toasts in the same tick renders both with a gap', () => {
    const screen = render(
      <ToastProvider>
        <Trigger messages={['first', 'second']} />
      </ToastProvider>,
    );
    // First toast renders synchronously after the burst.
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.queryByText('second')).toBeNull();

    // Simulate the toast's auto-dismiss + gap window so the queue
    // advances.  Three timer flushes covers the fade-in animation,
    // the auto-dismiss timeout, and the gap-then-showNext.
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText('second')).toBeTruthy();
  });

  test('BUG-FE-UI-106: gap timer clears on unmount (no late setCurrentToast)', () => {
    // Spy on setTimeout / clearTimeout so we can assert the gap timer
    // is cancelled, not just left to fire on a detached provider.
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const screen = render(
      <ToastProvider>
        <Trigger messages={['first', 'second']} />
      </ToastProvider>,
    );
    expect(screen.getByText('first')).toBeTruthy();

    // Drive the queue into the inter-toast gap, then unmount.
    act(() => {
      jest.advanceTimersByTime(3_500);
    });

    const beforeUnmountClears = clearSpy.mock.calls.length;
    screen.unmount();
    // The unmount cleanup should have called clearTimeout at least
    // once for the pending gap timer.  Cannot assert on the exact
    // timer ID, but a strict-greater-than ensures the cleanup ran.
    expect(clearSpy.mock.calls.length).toBeGreaterThan(beforeUnmountClears);
    clearSpy.mockRestore();
  });
});
