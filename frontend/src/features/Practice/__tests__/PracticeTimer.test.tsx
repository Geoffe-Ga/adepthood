/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('expo-av', () => ({
  Audio: {
    Sound: {
      createAsync: (jest.fn() as any).mockResolvedValue({
        sound: {
          playAsync: (jest.fn() as any).mockResolvedValue(undefined),
          unloadAsync: (jest.fn() as any).mockResolvedValue(undefined),
        },
      }),
    },
  },
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (jest.fn() as any).mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock('react-native/Libraries/Vibration/Vibration', () => ({
  vibrate: jest.fn(),
}));

// eslint-disable-next-line import/order
const { render, fireEvent, act } = require('@testing-library/react-native');
const PracticeTimer = require('../PracticeTimer').default;

describe('PracticeTimer', () => {
  const mockOnComplete = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders with initial time display', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );
    expect(getByTestId('time-remaining')).toBeTruthy();
    expect(getByTestId('time-remaining').props.children).toBe('10:00');
  });

  it('shows start button in idle state', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );
    expect(getByTestId('start-button')).toBeTruthy();
  });

  it('shows pause and cancel buttons after starting', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    expect(getByTestId('pause-button')).toBeTruthy();
    expect(getByTestId('cancel-button')).toBeTruthy();
  });

  it('counts down when running', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={1} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(getByTestId('time-remaining').props.children).toBe('00:57');
  });

  it('shows resume button when paused', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    act(() => {
      fireEvent.press(getByTestId('pause-button'));
    });

    expect(getByTestId('resume-button')).toBeTruthy();
  });

  it('calls onCancel when cancel is pressed', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    act(() => {
      fireEvent.press(getByTestId('cancel-button'));
    });

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('calls onComplete when timer finishes', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={1} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    // Advance past the full 60 seconds
    act(() => {
      jest.advanceTimersByTime(61000);
    });

    expect(mockOnComplete).toHaveBeenCalledWith(1);
  });

  it('activates keep awake when started', () => {
    const { activateKeepAwakeAsync } = require('expo-keep-awake');
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    expect(activateKeepAwakeAsync).toHaveBeenCalledWith('practice-timer');
  });

  it('deactivates keep awake when cancelled', () => {
    const { deactivateKeepAwake } = require('expo-keep-awake');
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    act(() => {
      fireEvent.press(getByTestId('cancel-button'));
    });

    expect(deactivateKeepAwake).toHaveBeenCalledWith('practice-timer');
  });

  it('plays start sound when timer begins', () => {
    const { Audio } = require('expo-av');
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={10} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    expect(Audio.Sound.createAsync).toHaveBeenCalled();
  });

  it('resumes countdown after pause', () => {
    const { getByTestId } = render(
      <PracticeTimer durationMinutes={1} onComplete={mockOnComplete} onCancel={mockOnCancel} />,
    );

    act(() => {
      fireEvent.press(getByTestId('start-button'));
    });

    act(() => {
      jest.advanceTimersByTime(5000);
    });

    act(() => {
      fireEvent.press(getByTestId('pause-button'));
    });

    // Time should not advance while paused
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    const timeAfterPause = getByTestId('time-remaining').props.children;

    act(() => {
      fireEvent.press(getByTestId('resume-button'));
    });

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // Time should have advanced further
    const timeAfterResume = getByTestId('time-remaining').props.children;
    expect(timeAfterResume).not.toBe(timeAfterPause);
  });
});
