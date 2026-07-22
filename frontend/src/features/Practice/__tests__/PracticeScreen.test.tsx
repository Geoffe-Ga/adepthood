/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { useSyncExternalStore, type ReactElement } from 'react';

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
const mockGoBack = jest.fn();
const mockRouteParams: Record<string, unknown> = {};
// PracticeScreen installs its header-left drawer toggle through
// useAppNavigation (useScreenDrawer), which calls navigation.setOptions in a
// layout effect on every mount -- without this mock every existing test below
// would crash reading setOptions off an undefined navigation object. The store
// relays the installed headerLeft into the same render tree as the screen so
// the Modal-based drawer opens in-tree and its rows are pressable.
const headerLeftStore: {
  current: (() => ReactElement) | undefined;
  listeners: Set<() => void>;
} = { current: undefined, listeners: new Set() };
const mockSetOptions = jest.fn((opts: { headerLeft?: () => ReactElement }) => {
  headerLeftStore.current = opts.headerLeft;
  headerLeftStore.listeners.forEach((listener) => listener());
});
jest.mock('../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
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
    useNavigation: () => ({ navigate: mockRootNavigate, goBack: mockGoBack }),
    useRoute: () => ({ key: 'Practice-test', name: 'Practice', params: mockRouteParams }),
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

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

// Renders the screen's headerLeft toggle in the same tree as the screen, so the
// drawer opens in-tree and its rows are pressable.
const PracticeScreenWithHeader = (): ReactElement => {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <PracticeScreen />
    </>
  );
};

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
    mockSetOptions.mockClear();
    mockRootNavigate.mockClear();
  });

  it('shows loading indicator initially', async () => {
    mockPracticesList.mockReturnValue(new Promise(() => {}));
    mockUserPracticesList.mockReturnValue(new Promise(() => {}));
    mockInsights.mockReturnValue(new Promise(() => {}));
    mockWeekCount.mockReturnValue(new Promise(() => {}));
    mockFrequency.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<PracticeScreen />);
    expect(getByTestId('practice-loading')).toBeTruthy();
    // The screen-level shell owns the top inset; the loading leaf keeps only the bottom.
    const { StyleSheet } = require('react-native');
    expect(getByTestId('practice-screen-safe-area')).toHaveStyle({ paddingTop: 47 });
    const loadingFlat = StyleSheet.flatten(getByTestId('practice-loading').props.style);
    expect(loadingFlat.paddingBottom).toBe(34);
    expect(loadingFlat.paddingTop).not.toBe(47);
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
    // The shell owns the top inset once; the empty leaf keeps only the bottom.
    const { StyleSheet } = require('react-native');
    expect(getByTestId('practice-screen-safe-area')).toHaveStyle({ paddingTop: 47 });
    const emptyFlat = StyleSheet.flatten(getByTestId('practice-empty-state').props.style);
    expect(emptyFlat.paddingBottom).toBe(34);
    expect(emptyFlat.paddingTop).not.toBe(47);
  });

  it('empty-state "Browse practices" flips to the Catalog tab in place, without a push', async () => {
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('browse-catalog-button'));
    });

    await waitFor(() => expect(getByTestId('practice-catalog-screen')).toBeTruthy());
    expect(queryByTestId('practice-empty-state')).toBeNull();
    expect(mockRootNavigate).not.toHaveBeenCalled();
  });

  it('shows error state when the load fails', async () => {
    mockPracticesList.mockRejectedValue(new Error('Network error'));
    const { getByTestId, getByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-error')).toBeTruthy();
      expect(getByText(/couldn't load your practices/i)).toBeTruthy();
    });
    // The shell owns the top inset once; the error leaf keeps only the bottom.
    const { StyleSheet } = require('react-native');
    expect(getByTestId('practice-screen-safe-area')).toHaveStyle({ paddingTop: 47 });
    const errorFlat = StyleSheet.flatten(getByTestId('practice-error').props.style);
    expect(errorFlat.paddingBottom).toBe(34);
    expect(errorFlat.paddingTop).not.toBe(47);
  });

  it('renders the identity header with title, ritual name, and pencil when a practice is selected', async () => {
    mockUserPracticesList.mockResolvedValue([
      sampleUserPractice({ custom_name: 'Morning Sit', effective_name: 'Morning Sit' }),
    ]);
    const { getByTestId, queryByTestId, queryByText } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-identity-header')).toBeTruthy();
      expect(getByTestId('meditation-timer-view')).toBeTruthy();
    });
    // Title is the underlying practice's name; the ritual name shows the
    // user's effective (customized) name for it.
    expect(getByTestId('practice-identity-title')).toHaveTextContent('Breath Awareness');
    expect(getByTestId('practice-identity-ritual-name')).toHaveTextContent('Morning Sit');
    const pencil = getByTestId('practice-customize-pencil');
    expect(pencil.props.accessibilityRole).toBe('button');
    expect(pencil.props.accessibilityLabel).toBe('Customize this ritual');
    // The old SessionCard header band (name + gear) is retired.
    expect(queryByTestId('active-practice-header-band')).toBeNull();
    expect(queryByTestId('active-practice-name')).toBeNull();
    expect(queryByTestId('active-practice-configure')).toBeNull();
    expect(queryByText('Adjust')).toBeNull();
  });

  it('renders the session flat on the dark ground with no bottom fade', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(queryByTestId('bottom-fade')).toBeNull();
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

  it('wraps the running session mode view in the umber SessionSurface', async () => {
    // The active session provides the full-bleed umber surface to the mode
    // view, so the interior blends into the dark player ground (#1905).
    const { StyleSheet } = require('react-native');
    const { showcase } = require('../../../design/tokens');
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('meditation-timer-view')).toBeTruthy());
    const ground = StyleSheet.flatten(getByTestId('meditation-timer-view').props.style);
    expect(ground.backgroundColor).toBe(showcase.canvas);
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

  it('retires the "Begin a session" showcase hero from the player', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId, queryByText } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    // The whole screen is now the dark player; the engine's own Begin control
    // (ritual-start) still drives idle → running unchanged.
    expect(queryByTestId('practice-begin-hero')).toBeNull();
    expect(queryByText('Begin a session')).toBeNull();
    expect(getByTestId('ritual-start')).toBeTruthy();
  });

  it('begins the session from the unchanged engine start control', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    // Pressing Begin (ritual-start) transitions the engine into a running
    // session — the meditation timer view exposes its running cancel control.
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    expect(queryByTestId('ritual-cancel')).toBeTruthy();
    jest.useRealTimers();
  });

  it('retires the inline change-practice button (the drawer keeps the catalog path)', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(queryByTestId('change-practice-button')).toBeNull();
  });

  it('applies safe-area insets and the full-bleed umber ground with no outer scroll', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('active-practice-card')).toBeTruthy();
    });
    const { showcase } = require('../../../design/tokens');
    const { StyleSheet } = require('react-native');
    // The dark shell pads the top exactly once; the session leaf owns the
    // bottom inset. The body is a plain flex view (no ScrollView, so no
    // contentContainerStyle).
    expect(getByTestId('practice-screen-safe-area')).toHaveStyle({
      paddingTop: 47,
      backgroundColor: showcase.canvas,
    });
    const shellFlat = StyleSheet.flatten(getByTestId('practice-screen-safe-area').props.style);
    expect(shellFlat.paddingBottom).not.toBe(34);
    const bodyFlat = StyleSheet.flatten(getByTestId('practice-screen').props.style);
    expect(bodyFlat.paddingBottom).toBe(34);
    expect(bodyFlat.paddingTop).not.toBe(47);
    expect(getByTestId('practice-screen').props.contentContainerStyle).toBeUndefined();
  });

  it('pins the weekly progress footer inside the fixed player body', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(within(getByTestId('practice-screen')).getByTestId('weekly-progress')).toBeTruthy();
  });

  it('opens the configurator sheet when the pencil is pressed', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-customize-pencil')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(getByTestId('practice-customize-pencil'));
    });
    expect(getByTestId('ritual-configurator-sheet')).toBeTruthy();
  });

  it('fetches the frequency and renders the tappable stage chip on the idle player', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByText, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => {
      expect(getByTestId('practice-stage-chip')).toBeTruthy();
    });
    expect(getByText('BEIGE · Body')).toBeTruthy();
    expect(mockFrequency).toHaveBeenCalled();
    expect(mockFrequency.mock.calls[0][0]).toBe(1);
    const chip = getByTestId('practice-stage-chip');
    expect(chip.props.accessibilityRole).toBe('button');
    expect(chip.props.accessibilityLabel).toBe('Change stage. Current: Beige, Body');
    // The old banner surface stays retired; the chip is the stage identity now.
    expect(queryByTestId('frequency-banner-content')).toBeNull();
  });

  it('stage chip opens the picker and picking a stage re-drives the load for it', async () => {
    const stageThreePractice = samplePractice({ id: 3, stage_number: 3, name: 'Candle Gazing' });
    mockPracticesList.mockImplementation((options: unknown) => {
      const stage =
        typeof options === 'object' && options !== null
          ? (options as { stageNumber?: number }).stageNumber
          : undefined;
      return Promise.resolve(stage === 3 ? [stageThreePractice] : [samplePractice()]);
    });
    mockUserPracticesList.mockResolvedValue([
      sampleUserPractice(),
      sampleUserPractice({ id: 30, practice_id: 3, stage_number: 3 }),
    ]);
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-stage-chip')).toBeTruthy());

    fireEvent.press(getByTestId('practice-stage-chip'));
    expect(getByTestId('practice-stage-pick-3')).toBeTruthy();
    expect(getByTestId('practice-stage-pick-cancel')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('practice-stage-pick-3'));
    });

    await waitFor(() => {
      expect(mockPracticesList).toHaveBeenCalledWith(expect.objectContaining({ stageNumber: 3 }));
      const frequencyStages = mockFrequency.mock.calls.map((call: unknown[]) => call[0]);
      expect(frequencyStages).toContain(3);
    });
  });

  it('collapses the identity header to the title only while a session runs', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-stage-chip')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    expect(queryByTestId('practice-stage-chip')).toBeNull();
    expect(queryByTestId('practice-customize-pencil')).toBeNull();
    expect(queryByTestId('practice-identity-ritual-name')).toBeNull();
    expect(getByTestId('practice-identity-title')).toBeTruthy();
    jest.useRealTimers();
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

  it('renders the Practice | Catalog switcher with Practice active by default', async () => {
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    const switcher = getByTestId('practice-tab-switcher');
    expect(switcher.props.accessibilityRole).toBe('tablist');
    const practiceTab = getByTestId('practice-tab-practice');
    const catalogTab = getByTestId('practice-tab-catalog');
    expect(practiceTab.props.accessibilityRole).toBe('tab');
    expect(catalogTab.props.accessibilityRole).toBe('tab');
    expect(practiceTab.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(catalogTab.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('tapping the Catalog tab renders the catalog in place on the dark ground, not as a push', async () => {
    const { StyleSheet } = require('react-native');
    const { onShowcase } = require('../../../design/tokens');
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('practice-tab-catalog'));
    });

    await waitFor(() => expect(getByTestId('practice-catalog-screen')).toBeTruthy());
    expect(getByTestId('practice-catalog-row-1')).toBeTruthy();
    expect(getByTestId('practice-tab-catalog').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    // Embedded dark variant: no pushed screen, no light safe-area wrapper, no
    // light ScreenHeader Create CTA, and section titles read in onShowcase ink.
    expect(mockRootNavigate).not.toHaveBeenCalled();
    expect(queryByTestId('practice-catalog-safe-area')).toBeNull();
    expect(queryByTestId('practice-catalog-create')).toBeNull();
    const presetsTitle = within(getByTestId('practice-catalog-section-presets')).getByText(
      'Presets',
    );
    expect(StyleSheet.flatten(presetsTitle.props.style).color).toBe(onShowcase.soft);
  });

  it('activating a practice from the embedded catalog flips back with a single refresh', async () => {
    mockUserPracticesList.mockResolvedValueOnce([]).mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('practice-tab-catalog'));
    });
    await waitFor(() => expect(getByTestId('practice-catalog-row-1-use')).toBeTruthy());

    const listCallsBeforeUse = mockUserPracticesList.mock.calls.length;
    await act(async () => {
      fireEvent.press(getByTestId('practice-catalog-row-1-use'));
    });

    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(queryByTestId('practice-catalog-screen')).toBeNull();
    expect(getByTestId('practice-tab-practice').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 1, stage_number: 1 });
    // Exactly one refresh-triggered re-read of the user's practices, and no
    // goBack / push navigation for the embedded flow.
    expect(mockUserPracticesList.mock.calls.length).toBe(listCallsBeforeUse + 1);
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockRootNavigate).not.toHaveBeenCalled();
  });

  it('hides the switcher while a session runs and restores it once idle again', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, queryByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    expect(getByTestId('practice-tab-switcher')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });
    expect(queryByTestId('practice-tab-switcher')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('ritual-cancel'));
    });
    expect(getByTestId('practice-tab-switcher')).toBeTruthy();
    jest.useRealTimers();
  });
});

describe('PracticeScreen header drawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    headerLeftStore.current = undefined;
    headerLeftStore.listeners.clear();
    mockFocusCallbacks.length = 0;
    mockPracticesList.mockResolvedValue([samplePractice()]);
    mockUserPracticesList.mockResolvedValue([]);
    mockWeekCount.mockResolvedValue({ count: 2 });
    mockInsights.mockRejectedValue(new Error('insights unavailable'));
    mockFrequency.mockResolvedValue(sampleFrequency);
    mockUserPracticesCreate.mockResolvedValue(sampleUserPractice());
    mockNavigate.mockClear();
    mockSetOptions.mockClear();
    mockRootNavigate.mockClear();
  });

  it('opens the drawer and shows the full active-state row set, with the inline controls retired', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByLabelText, queryByTestId } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));

    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
    expect(getByTestId('practice-drawer-change')).toBeTruthy();
    expect(getByTestId('practice-drawer-browse')).toBeTruthy();
    expect(getByTestId('practice-drawer-customize')).toBeTruthy();
    expect(getByTestId('practice-drawer-details')).toBeTruthy();
    expect(getByTestId('practice-drawer-create')).toBeTruthy();
    // The inline CatalogButton is retired (#1905): the drawer rows are the
    // interim catalog path until the epic's tab switcher lands.
    expect(queryByTestId('change-practice-button')).toBeNull();
  });

  it('pressing the drawer "Change practice" row flips to the Catalog tab in place', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByLabelText } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));
    await act(async () => {
      fireEvent.press(getByTestId('practice-drawer-change'));
    });

    await waitFor(() => expect(getByTestId('practice-catalog-screen')).toBeTruthy());
    expect(mockRootNavigate).not.toHaveBeenCalled();
  });

  it('pressing the drawer "Browse all practices" row flips to the Catalog tab in place', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByLabelText } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));
    await act(async () => {
      fireEvent.press(getByTestId('practice-drawer-browse'));
    });

    await waitFor(() => expect(getByTestId('practice-catalog-screen')).toBeTruthy());
    expect(mockRootNavigate).not.toHaveBeenCalled();
  });

  it('withholds the in-place catalog rows while a session runs so the drawer cannot destroy the ritual', async () => {
    jest.useFakeTimers();
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByLabelText, queryByTestId } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('ritual-start'));
    });

    fireEvent.press(getByLabelText('Open Practice menu'));

    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
    // Flipping the embedded Catalog tab unmounts the running engine, so the two
    // in-place catalog rows are withheld while the ritual holds the screen.
    expect(queryByTestId('practice-drawer-change')).toBeNull();
    expect(queryByTestId('practice-drawer-browse')).toBeNull();
    // Safe rows remain: customize opens a modal sheet, create/details push.
    expect(getByTestId('practice-drawer-customize')).toBeTruthy();
    expect(getByTestId('practice-drawer-create')).toBeTruthy();
    // The running session is untouched by opening the drawer.
    expect(getByTestId('ritual-cancel')).toBeTruthy();
    jest.useRealTimers();
  });

  it('opens the drawer and shows only the browse/create rows when there is no active practice, alongside the unchanged in-body CTA', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));

    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
    expect(getByTestId('practice-drawer-browse')).toBeTruthy();
    expect(getByTestId('practice-drawer-create')).toBeTruthy();
    expect(queryByTestId('practice-drawer-change')).toBeNull();
    expect(queryByTestId('practice-drawer-customize')).toBeNull();
    expect(queryByTestId('practice-drawer-details')).toBeNull();
    // The in-body empty-state CTA is not replaced by the drawer's rows.
    expect(getByTestId('browse-catalog-button')).toBeTruthy();
  });

  it('pressing the drawer "Customize this practice" row opens the configurator sheet', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByLabelText } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));
    await act(async () => {
      fireEvent.press(getByTestId('practice-drawer-customize'));
    });

    expect(getByTestId('ritual-configurator-sheet')).toBeTruthy();
  });

  it('pressing the drawer "Create a practice" row navigates via the root stack navigator', async () => {
    mockUserPracticesList.mockResolvedValue([sampleUserPractice()]);
    const { getByTestId, getByLabelText } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));
    fireEvent.press(getByTestId('practice-drawer-create'));

    expect(mockRootNavigate).toHaveBeenCalledWith('CreatePractice');
  });
});
