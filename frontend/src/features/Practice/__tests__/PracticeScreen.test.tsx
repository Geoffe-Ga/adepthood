/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { PracticeItem, UserPractice } from '../../../api';

const samplePractices: PracticeItem[] = [
  {
    id: 1,
    stage_number: 1,
    name: 'Breath Awareness',
    description: 'Focus on the breath to develop concentration.',
    instructions: 'Sit comfortably and focus on your breathing.',
    default_duration_minutes: 10,
    submitted_by_user_id: null,
    approved: true,
  },
  {
    id: 2,
    stage_number: 1,
    name: 'Body Scan',
    description: 'Progressively scan through body sensations.',
    instructions: 'Start at the crown and slowly move attention downward.',
    default_duration_minutes: 15,
    submitted_by_user_id: null,
    approved: true,
  },
];

const sampleUserPractice: UserPractice = {
  id: 10,
  user_id: 1,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-01-15',
  end_date: null,
};

const mockPracticesList = (jest.fn() as any).mockResolvedValue(samplePractices);
const mockUserPracticesList = (jest.fn() as any).mockResolvedValue([]);
const mockUserPracticesCreate = (jest.fn() as any).mockResolvedValue(sampleUserPractice);
const mockPracticeSessionsCreate = (jest.fn() as any).mockResolvedValue({
  id: 100,
  user_id: 1,
  user_practice_id: 10,
  duration_minutes: 10,
  timestamp: '2026-01-15T10:30:00Z',
  reflection: null,
});
const mockWeekCount = (jest.fn() as any).mockResolvedValue({ count: 2 });

jest.mock('../../../api', () => ({
  practices: {
    list: (...args: unknown[]) => mockPracticesList(...args),
    get: jest.fn() as any,
  },
  userPractices: {
    create: (...args: unknown[]) => mockUserPracticesCreate(...args),
    list: (...args: unknown[]) => mockUserPracticesList(...args),
  },
  practiceSessions: {
    create: (...args: unknown[]) => mockPracticeSessionsCreate(...args),
    weekCount: (...args: unknown[]) => mockWeekCount(...args),
  },
}));

const mockNavigate = jest.fn();
const mockRouteParams: Record<string, unknown> = {};
jest.mock('../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: mockNavigate }),
  useAppRoute: () => ({ key: 'Practice-test', name: 'Practice', params: mockRouteParams }),
}));

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
const { render, waitFor, fireEvent, act } = require('@testing-library/react-native');
const PracticeScreen = require('../PracticeScreen').default;

describe('PracticeScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPracticesList.mockResolvedValue(samplePractices);
    mockUserPracticesList.mockResolvedValue([]);
    mockWeekCount.mockResolvedValue({ count: 2 });
    mockUserPracticesCreate.mockResolvedValue(sampleUserPractice);
    mockNavigate.mockClear();
  });

  it('shows loading indicator initially', () => {
    mockPracticesList.mockReturnValue(new Promise(() => {}));
    mockUserPracticesList.mockReturnValue(new Promise(() => {}));
    mockWeekCount.mockReturnValue(new Promise(() => {}));

    const { getByTestId } = render(<PracticeScreen />);
    expect(getByTestId('practice-loading')).toBeTruthy();
  });

  it('renders selection view with practice selector after loading', async () => {
    const { getByTestId, getByText } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('selection-view')).toBeTruthy();
      expect(getByText('Breath Awareness')).toBeTruthy();
      expect(getByText('Body Scan')).toBeTruthy();
    });
  });

  it('shows weekly progress', async () => {
    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('weekly-progress')).toBeTruthy();
    });
  });

  it('shows error state when API fails', async () => {
    mockPracticesList.mockRejectedValue(new Error('Network error'));

    const { getByTestId, getByText } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('practice-error')).toBeTruthy();
      expect(getByText(/couldn't load your practices/i)).toBeTruthy();
    });
  });

  it('shows retry button on error', async () => {
    mockPracticesList.mockRejectedValue(new Error('Network error'));

    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('retry-button')).toBeTruthy();
    });
  });

  it('selects a practice via the selector', async () => {
    const { getByTestId, getByText } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByText('Breath Awareness')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('select-practice-1'));
    });

    expect(mockUserPracticesCreate).toHaveBeenCalledWith({
      practice_id: 1,
      stage_number: 1,
    });
  });

  it('shows active practice card when user has selected a practice', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId, getByText } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('active-practice-card')).toBeTruthy();
      expect(getByText('Breath Awareness')).toBeTruthy();
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });
  });

  it('navigates to timer view when Start Practice is pressed', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-practice-button'));
    });

    expect(getByTestId('timer-view')).toBeTruthy();
  });

  it('shows summary view after timer completes', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-practice-button'));
    });

    expect(getByTestId('timer-view')).toBeTruthy();

    // Start the timer
    await act(async () => {
      fireEvent.press(getByTestId('start-button'));
    });

    // Advance past the full duration (10 minutes = 600 seconds)
    await act(async () => {
      jest.advanceTimersByTime(601000);
    });

    await waitFor(() => {
      expect(getByTestId('summary-view')).toBeTruthy();
      expect(getByTestId('summary-duration')).toBeTruthy();
    });

    jest.useRealTimers();
  });

  it('saves session when Save Session button is pressed', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-practice-button'));
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-button'));
    });

    await act(async () => {
      jest.advanceTimersByTime(601000);
    });

    await waitFor(() => {
      expect(getByTestId('save-session-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('save-session-button'));
    });

    // BUG-FE-PRACTICE-101: client must submit ISO timestamps, not a
    // setInterval-derived ``duration_minutes`` (the backend rejects the
    // legacy field with 422).
    expect(mockPracticeSessionsCreate).toHaveBeenCalledTimes(1);
    const submittedPayload = mockPracticeSessionsCreate.mock.calls[0][0];
    expect(submittedPayload).toEqual(
      expect.objectContaining({
        user_practice_id: 10,
        started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        ended_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
    expect(submittedPayload).not.toHaveProperty('duration_minutes');
    const submittedDurationMs =
      new Date(submittedPayload.ended_at).getTime() -
      new Date(submittedPayload.started_at).getTime();
    expect(submittedDurationMs).toBeGreaterThan(0);
    expect(submittedDurationMs).toBeLessThanOrEqual(10 * 60 * 1000);

    jest.useRealTimers();
  });

  it('calls practices.list with stage number', async () => {
    render(<PracticeScreen />);

    await waitFor(() => {
      expect(mockPracticesList).toHaveBeenCalledWith(1);
    });
  });

  it('fetches week count on mount', async () => {
    render(<PracticeScreen />);

    await waitFor(() => {
      expect(mockWeekCount).toHaveBeenCalled();
    });
  });

  it('shows reflection prompt after saving a session', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId, getByText } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-practice-button'));
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-button'));
    });

    await act(async () => {
      jest.advanceTimersByTime(601000);
    });

    await waitFor(() => {
      expect(getByTestId('save-session-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('save-session-button'));
    });

    await waitFor(() => {
      expect(getByTestId('reflection-view')).toBeTruthy();
      expect(getByText('Write a Reflection?')).toBeTruthy();
      expect(getByTestId('write-reflection-button')).toBeTruthy();
      expect(getByTestId('skip-reflection-button')).toBeTruthy();
    });

    jest.useRealTimers();
  });

  it('navigates to Journal when Write Reflection is pressed', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-practice-button'));
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-button'));
    });

    await act(async () => {
      jest.advanceTimersByTime(601000);
    });

    await waitFor(() => {
      expect(getByTestId('save-session-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('save-session-button'));
    });

    await waitFor(() => {
      expect(getByTestId('write-reflection-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('write-reflection-button'));
    });

    expect(mockNavigate).toHaveBeenCalledWith('Journal', {
      tag: 'practice_note',
      practiceSessionId: 100,
      userPracticeId: 10,
      practiceName: 'Breath Awareness',
      practiceDuration: 10,
    });

    jest.useRealTimers();
  });

  it('returns to selection when Skip Reflection is pressed', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice]);

    const { getByTestId } = render(<PracticeScreen />);

    await waitFor(() => {
      expect(getByTestId('start-practice-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-practice-button'));
    });

    await act(async () => {
      fireEvent.press(getByTestId('start-button'));
    });

    await act(async () => {
      jest.advanceTimersByTime(601000);
    });

    await waitFor(() => {
      expect(getByTestId('save-session-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('save-session-button'));
    });

    await waitFor(() => {
      expect(getByTestId('skip-reflection-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('skip-reflection-button'));
    });

    await waitFor(() => {
      expect(getByTestId('selection-view')).toBeTruthy();
    });

    jest.useRealTimers();
  });
});
