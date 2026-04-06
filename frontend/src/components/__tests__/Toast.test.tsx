import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act } from '@testing-library/react-native';
import React from 'react';

import Toast from '../Toast';
import { ToastProvider, useToast } from '../ToastProvider';

// Helper component that exposes showToast for testing
function ToastTrigger({
  onReady,
}: {
  onReady: (showToast: ReturnType<typeof useToast>['showToast']) => void;
}) {
  const { showToast } = useToast();
  React.useEffect(() => {
    onReady(showToast);
  }, [onReady, showToast]);
  return null;
}

describe('Toast component', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('renders message and icon', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <Toast message="Goal achieved!" icon="🎯" color="#807f66" onDismiss={onDismiss} />,
    );

    expect(getByTestId('toast-message').props.children).toBe('Goal achieved!');
    expect(getByTestId('toast-icon').props.children).toBe('🎯');
    expect(getByTestId('toast-container')).toBeTruthy();
  });

  it('renders without icon when not provided', () => {
    const onDismiss = jest.fn();
    const { queryByTestId, getByTestId } = render(
      <Toast message="No icon toast" onDismiss={onDismiss} />,
    );

    expect(getByTestId('toast-message').props.children).toBe('No icon toast');
    expect(queryByTestId('toast-icon')).toBeNull();
  });

  it('calls onDismiss after default duration', () => {
    const onDismiss = jest.fn();
    render(<Toast message="Auto dismiss" onDismiss={onDismiss} />);

    // Animation in (300ms) + display (3000ms) + animation out (300ms)
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(3000);
    });

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss after custom duration', () => {
    const onDismiss = jest.fn();
    render(<Toast message="Custom" duration={5000} onDismiss={onDismiss} />);

    // Animation in
    act(() => {
      jest.advanceTimersByTime(300);
    });

    // Not dismissed before 5000ms
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    // Dismissed after 5000ms + animation out
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('ToastProvider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('renders toast when showToast is called', () => {
    let triggerToast: ReturnType<typeof useToast>['showToast'];

    const { getByTestId } = render(
      <ToastProvider>
        <ToastTrigger onReady={(fn) => (triggerToast = fn)} />
      </ToastProvider>,
    );

    act(() => {
      triggerToast({ message: 'Hello toast', icon: '🏅' });
    });

    expect(getByTestId('toast-message').props.children).toBe('Hello toast');
    expect(getByTestId('toast-icon').props.children).toBe('🏅');
  });

  it('queues multiple toasts and shows them sequentially', () => {
    let triggerToast: ReturnType<typeof useToast>['showToast'];

    const { getByTestId, queryByTestId } = render(
      <ToastProvider>
        <ToastTrigger onReady={(fn) => (triggerToast = fn)} />
      </ToastProvider>,
    );

    act(() => {
      triggerToast({ message: 'First toast' });
      triggerToast({ message: 'Second toast' });
    });

    // First toast is visible
    expect(getByTestId('toast-message').props.children).toBe('First toast');

    // Dismiss first toast: animation in (300) + display (3000) + animation out (300) + gap (400)
    act(() => {
      jest.advanceTimersByTime(300);
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });

    // After dismiss, gap before next
    act(() => {
      jest.advanceTimersByTime(400);
    });

    // Second toast should now be visible
    const messageEl = queryByTestId('toast-message');
    expect(messageEl).toBeTruthy();
    expect(messageEl!.props.children).toBe('Second toast');
  });

  it('returns no-op showToast when used outside provider', () => {
    let toastFn: ReturnType<typeof useToast>['showToast'] | null = null;

    function StandaloneComponent() {
      const { showToast } = useToast();
      toastFn = showToast;
      return null;
    }

    render(<StandaloneComponent />);
    expect(toastFn).toBeDefined();
    // Should not throw when called outside provider
    expect(() => toastFn!({ message: 'test' })).not.toThrow();
  });
});
