/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { FrequencyResponse, PracticeItem, UserPractice } from '../../../api';
import type { ModeConfig } from '../engine/types';

const samplePractice = (overrides: Partial<PracticeItem> = {}): PracticeItem => ({
  id: 1,
  stage_number: 1,
  name: 'Breath Awareness',
  description: 'Focus on the breath to develop concentration.',
  instructions: 'Sit comfortably and focus on your breathing.',
  default_duration_minutes: 10,
  submitted_by_user_id: null,
  approved: true,
  mode: 'meditation_timer',
  mode_config: { mode: 'meditation_timer', duration_minutes: 10 },
  ...overrides,
});

const sampleUserPractice = (overrides: Partial<UserPractice> = {}): UserPractice => ({
  id: 10,
  user_id: 1,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
  ...overrides,
});

const sampleFrequency: FrequencyResponse = {
  stage_number: 1,
  color: 'Beige',
  aspect: 'Body',
  practice_name: 'Breath Awareness',
  practice_id: 1,
  user_practice_id: 10,
  banner_text: 'You are in the Beige frequency of APTITUDE.',
};

const mockPracticesList = (jest.fn() as any).mockResolvedValue([samplePractice()]);
const mockUserPracticesList = (jest.fn() as any).mockResolvedValue([]);
const mockUserPracticesCreate = (jest.fn() as any).mockResolvedValue(sampleUserPractice());
const mockUserPracticesCustomize = (jest.fn() as any).mockResolvedValue(sampleUserPractice());
const mockPracticeSessionsCreate = (jest.fn() as any).mockResolvedValue({
  id: 100,
  user_practice_id: 10,
  duration_minutes: 10,
  timestamp: '2026-04-12T10:30:00Z',
  reflection: null,
  mode: 'meditation_timer',
  mode_metadata: null,
  completed: true,
  insight: null,
});
const mockWeekCount = (jest.fn() as any).mockResolvedValue({ count: 2 });
const mockInsights = (jest.fn() as any).mockRejectedValue(new Error('insights unavailable'));
const mockFrequency = (jest.fn() as any).mockResolvedValue(sampleFrequency);

jest.mock('../../../api', () => ({
  practices: {
    list: (...args: unknown[]) => mockPracticesList(...args),
    get: jest.fn() as any,
  },
  userPractices: {
    create: (...args: unknown[]) => mockUserPracticesCreate(...args),
    list: (...args: unknown[]) => mockUserPracticesList(...args),
    customize: (...args: unknown[]) => mockUserPracticesCustomize(...args),
  },
  practiceSessions: {
    create: (...args: unknown[]) => mockPracticeSessionsCreate(...args),
    weekCount: (...args: unknown[]) => mockWeekCount(...args),
    insights: (...args: unknown[]) => mockInsights(...args),
  },
  frequency: {
    current: (...args: unknown[]) => mockFrequency(...args),
  },
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
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
          replayAsync: (jest.fn() as any).mockResolvedValue(undefined),
          unloadAsync: (jest.fn() as any).mockResolvedValue(undefined),
          setOnPlaybackStatusUpdate: jest.fn(),
        },
      }),
    },
  },
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (jest.fn() as any).mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
  useKeepAwake: jest.fn(),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: (jest.fn() as any).mockResolvedValue(undefined),
  selectionAsync: (jest.fn() as any).mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

// eslint-disable-next-line import/order
const { render, waitFor, fireEvent, act } = require('@testing-library/react-native');
const PracticeScreen = require('../PracticeScreen').default;

interface ModeFixture {
  label: string;
  practice: PracticeItem;
  mountTestId: string;
}

const modeFixtures: ModeFixture[] = [
  {
    label: 'meditation_timer',
    practice: samplePractice({
      id: 11,
      mode: 'meditation_timer',
      mode_config: { mode: 'meditation_timer', duration_minutes: 10 },
    }),
    mountTestId: 'meditation-timer-view',
  },
  {
    label: 'count_up',
    practice: samplePractice({
      id: 12,
      mode: 'count_up',
      mode_config: { mode: 'count_up' },
    }),
    mountTestId: 'count-up-timer-view',
  },
  {
    label: 'metronome',
    practice: samplePractice({
      id: 13,
      mode: 'metronome',
      mode_config: {
        mode: 'metronome',
        bpm: 60,
        timer: { mode: 'meditation_timer', duration_minutes: 5 },
      },
    }),
    mountTestId: 'metronome-view',
  },
  {
    label: 'interval_bell',
    practice: samplePractice({
      id: 14,
      mode: 'interval_bell',
      mode_config: {
        mode: 'interval_bell',
        duration_minutes: 10,
        interval_minutes: 2,
        bell_tone: 'bowl',
      },
    }),
    mountTestId: 'interval-bell-view',
  },
  {
    label: 'rep_counter',
    practice: samplePractice({
      id: 15,
      mode: 'rep_counter',
      mode_config: { mode: 'rep_counter', target_reps: 108, unit_label: 'beads' },
    }),
    mountTestId: 'rep-counter-view',
  },
  {
    label: 'sense_grounding',
    practice: samplePractice({
      id: 16,
      mode: 'sense_grounding',
      mode_config: {
        mode: 'sense_grounding',
        prompts: [
          { sense: 'sight', label: 'five sights' },
          { sense: 'touch', label: 'four touches' },
          { sense: 'hearing', label: 'three sounds' },
          { sense: 'smell', label: 'two scents' },
          { sense: 'taste', label: 'one taste' },
        ],
      } as ModeConfig,
    }),
    mountTestId: 'sense-grounding-view',
  },
  {
    label: 'tarot',
    practice: samplePractice({
      id: 17,
      mode: 'tarot',
      mode_config: { mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 },
    }),
    mountTestId: 'tarot-meditation-view',
  },
];

describe('PracticeScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPracticesList.mockResolvedValue([samplePractice()]);
    mockUserPracticesList.mockResolvedValue([]);
    mockWeekCount.mockResolvedValue({ count: 2 });
    mockInsights.mockRejectedValue(new Error('insights unavailable'));
    mockFrequency.mockResolvedValue(sampleFrequency);
    mockUserPracticesCreate.mockResolvedValue(sampleUserPractice());
    mockNavigate.mockClear();
  });

  it('shows loading indicator initially', async () => {
    mockPracticesList.mockReturnValue(new Promise(() => {}));
    mockUserPracticesList.mockReturnValue(new Promise(() => {}));
    mockInsights.mockReturnValue(new Promise(() => {}));
    mockWeekCount.mockReturnValue(new Promise(() => {}));
    mockFrequency.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<PracticeScreen />);
    expect(getByTestId('practice-loading')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('renders selector + weekly progress when the user has no active practice', async () => {
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('selection-view')).toBeTruthy();
      expect(getByText('Breath Awareness')).toBeTruthy();
      expect(getByTestId('weekly-progress')).toBeTruthy();
    });
  });

  it('shows error state when the load fails', async () => {
    mockPracticesList.mockRejectedValue(new Error('Network error'));
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-error')).toBeTruthy();
      expect(getByText(/couldn't load your practices/i)).toBeTruthy();
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
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 1, stage_number: 1 });
  });

  it('renders the active practice card with configure gear when a practice is selected', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('active-practice-card')).toBeTruthy();
      expect(getByTestId('active-practice-configure')).toBeTruthy();
      expect(getByTestId('meditation-timer-view')).toBeTruthy();
    });
  });

  it('opens the configurator sheet when the gear is pressed', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('active-practice-configure')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('active-practice-configure'));
    });
    expect(getByTestId('ritual-configurator-sheet')).toBeTruthy();
  });

  it('opens the practice switcher when the banner is tapped', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('frequency-banner-content')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('frequency-banner-content'));
    });
    await waitFor(() => {
      expect(getByTestId('practice-switcher-sheet')).toBeTruthy();
    });
  });

  describe.each(modeFixtures)('mode dispatch — $label', ({ practice, mountTestId }) => {
    it(`mounts ${mountTestId} for ${practice.mode}`, async () => {
      mockPracticesList.mockResolvedValue([practice]);
      mockUserPracticesList.mockResolvedValue([
        sampleUserPractice({ id: practice.id + 100, practice_id: practice.id }),
      ]);
      const { getByTestId } = render(<PracticeScreen />);
      await waitFor(() => {
        expect(getByTestId(mountTestId)).toBeTruthy();
      });
    });
  });

  it('opens the insight capture modal when the engine completes a meditation timer', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    expect(queryByTestId('insight-save')).toBeFalsy();
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });
    await waitFor(() => {
      expect(getByTestId('insight-save')).toBeTruthy();
      expect(getByTestId('insight-summary')).toBeTruthy();
    });
    jest.useRealTimers();
  });

  it('does NOT open the insight modal when the user cancels mid-session', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await act(async () => {
      fireEvent.press(getByTestId('ritual-cancel'));
    });
    expect(queryByTestId('insight-save')).toBeFalsy();
    expect(mockPracticeSessionsCreate).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('submits an insight + mode metadata when Save is pressed', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });
    await waitFor(() => {
      expect(getByTestId('insight-save')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.changeText(getByTestId('insight-input'), 'My mind quieted.');
    });
    await act(async () => {
      fireEvent.press(getByTestId('insight-save'));
    });
    expect(mockPracticeSessionsCreate).toHaveBeenCalledTimes(1);
    const payload = mockPracticeSessionsCreate.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        user_practice_id: 10,
        mode_metadata: { mode: 'meditation_timer' },
        completed: true,
        insight: 'My mind quieted.',
        started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        ended_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
    expect(payload).not.toHaveProperty('duration_minutes');
    jest.useRealTimers();
  });

  it('rolls back the optimistic week-count increment when save fails (BUG-FE-PRACTICE-005)', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    mockInsights.mockResolvedValueOnce({
      weekly_counts: [{ week_start: '2026-05-11', count: 2 }],
      streak_weeks: 0,
      total_minutes_30d: 0,
      avg_duration_minutes_30d: null,
      per_mode_counts: {},
      last_insight: null,
    });
    mockPracticeSessionsCreate.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    expect(getByText(/2\s*\/\s*\d+/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });
    await waitFor(() => {
      expect(getByTestId('insight-save')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('insight-save'));
    });
    await waitFor(() => {
      expect(getByTestId('active-practice-save-error')).toBeTruthy();
      expect(getByText(/We couldn't save your practice session/)).toBeTruthy();
    });
    expect(getByText(/2\s*\/\s*\d+/)).toBeTruthy();
    expect(mockInsights).toHaveBeenCalledTimes(1);
    expect(mockWeekCount).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('refetches the authoritative week count after a successful save', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    mockInsights
      .mockResolvedValueOnce({
        weekly_counts: [{ week_start: '2026-05-11', count: 2 }],
        streak_weeks: 0,
        total_minutes_30d: 0,
        avg_duration_minutes_30d: null,
        per_mode_counts: {},
        last_insight: null,
      })
      .mockResolvedValueOnce({
        weekly_counts: [{ week_start: '2026-05-11', count: 7 }],
        streak_weeks: 0,
        total_minutes_30d: 70,
        avg_duration_minutes_30d: 10,
        per_mode_counts: { meditation_timer: 7 },
        last_insight: null,
      });
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });
    await waitFor(() => {
      expect(getByTestId('insight-save')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('insight-save'));
    });
    await waitFor(() => {
      expect(mockInsights).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(getByText(/7\s*\/\s*\d+/)).toBeTruthy();
    });
    jest.useRealTimers();
  });

  it('Skip submits the session without an insight', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });
    await waitFor(() => {
      expect(getByTestId('insight-skip')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('insight-skip'));
    });
    expect(mockPracticeSessionsCreate).toHaveBeenCalledTimes(1);
    expect(mockPracticeSessionsCreate.mock.calls[0][0].insight).toBeNull();
    jest.useRealTimers();
  });

  it('navigates to Journal when "Save & journal with BotMason" is pressed', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('ritual-start')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });
    await waitFor(() => {
      expect(getByTestId('insight-journal')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('insight-journal'));
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        'Journal',
        expect.objectContaining({
          tag: 'practice_note',
          practiceSessionId: 100,
          userPracticeId: 10,
          practiceName: 'Breath Awareness',
        }),
      );
    });
    jest.useRealTimers();
  });

  it('uses the ritual-04 insights endpoint when available, skipping the legacy fallback', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    mockInsights.mockResolvedValueOnce({
      weekly_counts: [
        { week_start: '2026-04-06', count: 3 },
        { week_start: '2026-04-13', count: 5 },
      ],
      streak_weeks: 2,
      total_minutes_30d: 100,
      avg_duration_minutes_30d: 12.5,
      per_mode_counts: { meditation_timer: 7 },
      last_insight: null,
    });
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('weekly-progress')).toBeTruthy();
      expect(getByText(/5\s*\/\s*\d+/)).toBeTruthy();
    });
    expect(mockInsights).toHaveBeenCalled();
    expect(mockWeekCount).not.toHaveBeenCalled();
  });

  it('falls back to week-count when the insights endpoint errors', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    mockInsights.mockRejectedValueOnce(new Error('insights 404'));
    mockWeekCount.mockResolvedValueOnce({ count: 9 });
    const { getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByText(/9\s*\/\s*\d+/)).toBeTruthy();
    });
    expect(mockWeekCount).toHaveBeenCalled();
  });
});
