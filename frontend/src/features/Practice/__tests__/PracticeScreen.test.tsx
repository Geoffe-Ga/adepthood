/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { FrequencyResponse, PracticeItem, UserPractice } from '../../../api';

// PracticeScreen reads useSafeAreaInsets; stub it with non-zero insets (no
// SafeAreaProvider in tests) so the safe-area padding is observable.
jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  const passthrough = ({ children }: { children: unknown }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

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
    listAll: (...args: unknown[]) => mockPracticesList(...args),
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
const mockRootNavigate = jest.fn();
const mockRouteParams: Record<string, unknown> = {};
jest.mock('../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: mockNavigate }),
  useAppRoute: () => ({ key: 'Practice-test', name: 'Practice', params: mockRouteParams }),
}));

// Captured focus callbacks so tests can simulate the screen regaining focus
// (e.g. returning from the catalog after picking a practice).
const mockFocusCallbacks: Array<() => void | (() => void)> = [];

// The "Browse all practices" button navigates via the stack-typed useNavigation
// (Catalog is a pushed RootStack route, not a tab). ``useFocusEffect`` is stubbed
// to run the callback on mount and to expose it for manual re-triggering.
jest.mock('@react-navigation/native', () => {
  const reactMod = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    ...(jest.requireActual('@react-navigation/native') as object),
    useNavigation: () => ({ navigate: mockRootNavigate }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      reactMod.useEffect(() => {
        mockFocusCallbacks.push(cb);
        const cleanup = cb();
        return () => {
          const index = mockFocusCallbacks.indexOf(cb);
          if (index >= 0) mockFocusCallbacks.splice(index, 1);
          if (typeof cleanup === 'function') cleanup();
        };
      }, [cb]);
    },
  };
});

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
const { render, waitFor, fireEvent, act, within } = require('@testing-library/react-native');
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
      },
    }),
    mountTestId: 'sense-grounding-view',
  },
  {
    label: 'tallied_grounding',
    practice: samplePractice({
      id: 18,
      mode: 'tallied_grounding',
      mode_config: {
        mode: 'tallied_grounding',
        rounds: 3,
        categories: [
          { key: 'squares', label: 'a square', target_count: 3 },
          { key: 'triangles', label: 'a triangle', target_count: 3 },
          { key: 'circles', label: 'a circle', target_count: 3 },
        ],
      },
    }),
    mountTestId: 'tallied-grounding-view',
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
    mockFocusCallbacks.length = 0;
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
    // Loading state respects device insets too.
    expect(getByTestId('practice-loading')).toHaveStyle({ paddingTop: 47, paddingBottom: 34 });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('renders the minimal empty state when the user has no active practice', async () => {
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-empty-state')).toBeTruthy();
      expect(getByText('No practice set for this stage yet.')).toBeTruthy();
      expect(getByTestId('browse-catalog-button')).toBeTruthy();
    });
    // The empty surface applies top/bottom safe-area insets.
    expect(getByTestId('practice-empty-state')).toHaveStyle({ paddingTop: 47, paddingBottom: 34 });
  });

  it('empty-state "Browse practices" opens the Catalog with the current stage', async () => {
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    fireEvent.press(getByTestId('browse-catalog-button'));
    expect(mockRootNavigate).toHaveBeenCalledWith('Catalog', { stageNumber: 1 });
  });

  it('shows error state when the load fails', async () => {
    mockPracticesList.mockRejectedValue(new Error('Network error'));
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-error')).toBeTruthy();
      expect(getByText(/couldn't load your practices/i)).toBeTruthy();
    });
    expect(getByTestId('practice-error')).toHaveStyle({ paddingTop: 47, paddingBottom: 34 });
  });

  it('renders the active practice card with an "Adjust" control when a practice is selected', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('active-practice-card')).toBeTruthy();
      expect(getByTestId('active-practice-configure')).toBeTruthy();
      expect(getByTestId('meditation-timer-view')).toBeTruthy();
    });
    expect(getByText('Adjust')).toBeTruthy();
    expect(getByTestId('active-practice-configure').props.accessibilityLabel).toBe(
      "Adjust this practice's settings",
    );
  });

  it('renders an active custom (draft) practice by including own drafts in the catalogue fetch', async () => {
    // A user-created practice is an unapproved draft: the backend lets its
    // author select it (POST /user-practices/ succeeds), but the approved-only
    // practices list omits it. The screen must fetch with includeMine so the
    // active row's practice resolves — otherwise the saved selection falls
    // into the "No practice yet" empty state (custom-practices selection bug).
    const draft = samplePractice({
      id: 42,
      name: 'My Custom Sit',
      approved: false,
      submitted_by_user_id: 1,
    });
    mockPracticesList.mockImplementation((options: unknown) => {
      const includeMine =
        typeof options === 'object' &&
        options !== null &&
        (options as { includeMine?: boolean }).includeMine === true;
      return Promise.resolve(includeMine ? [samplePractice(), draft] : [samplePractice()]);
    });
    mockUserPracticesList.mockResolvedValue([sampleUserPractice({ practice_id: 42 })]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(queryByTestId('practice-empty-state')).toBeNull();
  });

  it('wraps the running session mode view in the calm SessionSurface', async () => {
    // The active session now provides the calm lifted-paper surface to the mode
    // view, so the interior renders on the light raised ground; the deep umber
    // is reserved for the single Begin hero accent.
    const { StyleSheet } = require('react-native');
    const { surface } = require('../../../design/tokens');
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('meditation-timer-view')).toBeTruthy());
    const ground = StyleSheet.flatten(getByTestId('meditation-timer-view').props.style);
    expect(ground.backgroundColor).toBe(surface.raised);
  });

  it('reflects a practice selected elsewhere once the screen regains focus', async () => {
    // The Practice tab stays mounted while the user pushes to the catalog to
    // pick a practice. The selection saves there; on returning, a silent
    // focus-refresh must re-read it so the screen stops showing the empty state.
    mockUserPracticesList
      .mockResolvedValueOnce([]) // initial mount: nothing selected yet
      .mockResolvedValue([sampleUserPractice()]); // after focus: now selected
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    await act(async () => {
      mockFocusCallbacks.forEach((cb) => cb());
      await Promise.resolve();
    });

    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(queryByTestId('practice-empty-state')).toBeNull();
  });

  it('frames the active practice with a focal "Begin a session" showcase hero', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    // The warm showcase hero presents the arrival moment; the engine's own
    // Begin control (ritual-start) still drives idle → running unchanged.
    expect(getByTestId('practice-begin-hero')).toBeTruthy();
    expect(getByText('Begin a session')).toBeTruthy();
    expect(getByTestId('ritual-start')).toBeTruthy();
  });

  it('begins the session from the unchanged engine start control', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-begin-hero')).toBeTruthy());
    // Pressing Begin (ritual-start) transitions the engine into a running
    // session — the meditation timer view exposes its running cancel control.
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    expect(queryByTestId('ritual-cancel')).toBeTruthy();
    jest.useRealTimers();
  });

  it('change-practice opens the Catalog seeded to the current stage', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    fireEvent.press(getByTestId('change-practice-button'));
    expect(mockRootNavigate).toHaveBeenCalledWith('Catalog', { stageNumber: 1 });
  });

  it('applies safe-area insets to the active-session surface', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('active-practice-card')).toBeTruthy();
    });
    // Top inset constrains the wrapper viewport (so content can't scroll behind
    // the notch); bottom inset rides the ScrollView's contentContainerStyle.
    expect(getByTestId('practice-screen-safe-area')).toHaveStyle({ paddingTop: 47 });
    const scroll = getByTestId('practice-screen');
    expect(scroll.props.contentContainerStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 34 })]),
    );
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

  it('pins the frequency banner to the resolved stage', async () => {
    // The card and the banner must read the same stage. When the
    // client's resolved stage advances ahead of the server-stored
    // ``StageProgress.current_stage`` (e.g. the user moves their
    // program start date), passing the resolved stage to the
    // frequency endpoint keeps the banner colour in lockstep with the
    // practice card.
    mockRouteParams.stageNumber = 2;
    mockUserPracticesList.mockResolvedValue([sampleUserPractice({ stage_number: 2 })]);
    try {
      const { getByTestId } = render(<PracticeScreen />);
      await waitFor(() => {
        expect(getByTestId('active-practice-card')).toBeTruthy();
      });
      expect(mockFrequency).toHaveBeenCalledWith(2);
    } finally {
      delete mockRouteParams.stageNumber;
    }
  });

  it('shows the frequency chip (display-only) on the active screen', async () => {
    // The chip replaced the tappable banner; it no longer opens the switcher
    // (switching is a separate, explicit control).
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('frequency-banner-content')).toBeTruthy();
    });
    expect(getByTestId('frequency-banner-content').props.accessibilityRole).toBe('text');
    expect(queryByTestId('practice-switcher-sheet')).toBeNull();
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
    expect(getByText(/2 of \d+/)).toBeTruthy();
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
    expect(getByText(/2 of \d+/)).toBeTruthy();
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
      expect(getByText(/7 of \d+/)).toBeTruthy();
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
      expect(mockRootNavigate).toHaveBeenCalledWith(
        'JournalEntry',
        expect.objectContaining({
          practiceSessionId: 100,
          userPracticeId: 10,
          prefillTitle: 'After Breath Awareness',
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
      expect(getByText(/5 of \d+/)).toBeTruthy();
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
      expect(getByText(/9 of \d+/)).toBeTruthy();
    });
    expect(mockWeekCount).toHaveBeenCalled();
  });

  it('wraps the empty state in the shared content-capped container', async () => {
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    const container = getByTestId('content-container');
    expect(within(container).getByTestId('practice-empty-state')).toBeTruthy();
  });

  it('gives the shared content-capped container a bounded fill so native scroll/touch chains hold', async () => {
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    const { StyleSheet } = require('react-native');
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.flex).toBe(1);
  });

  it('wraps the active session view in the shared content-capped container', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    const container = getByTestId('content-container');
    expect(within(container).getByTestId('practice-screen')).toBeTruthy();
  });
});
