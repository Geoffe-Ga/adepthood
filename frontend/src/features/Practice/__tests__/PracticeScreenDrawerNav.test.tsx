/* eslint-env jest */
// RED coverage for the shared DrawerNavSection wired into the Practice header
// drawer. Mirrors PracticeScreen.test.tsx's "header drawer" harness.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { useSyncExternalStore, type ReactElement } from 'react';

import type {
  FrequencyResponse,
  PracticeInsightsResponse,
  PracticeItem,
  PracticeSessionResponse,
  UserPractice,
  WeekCountResponse,
} from '../../../api';
import PracticeScreen from '../PracticeScreen';

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

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

const mockPracticesList = jest
  .fn<(...args: unknown[]) => Promise<PracticeItem[]>>()
  .mockResolvedValue([samplePractice()]);
const mockUserPracticesList = jest
  .fn<(...args: unknown[]) => Promise<UserPractice[]>>()
  .mockResolvedValue([]);
const mockUserPracticesCreate = jest
  .fn<(...args: unknown[]) => Promise<UserPractice>>()
  .mockResolvedValue(sampleUserPractice());
const mockUserPracticesCustomize = jest
  .fn<(...args: unknown[]) => Promise<UserPractice>>()
  .mockResolvedValue(sampleUserPractice());
const mockPracticeSessionsCreate = jest
  .fn<(...args: unknown[]) => Promise<PracticeSessionResponse>>()
  .mockResolvedValue({
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
const mockWeekCount = jest
  .fn<(...args: unknown[]) => Promise<WeekCountResponse>>()
  .mockResolvedValue({ count: 2 });
const mockInsights = jest
  .fn<(...args: unknown[]) => Promise<PracticeInsightsResponse>>()
  .mockRejectedValue(new Error('insights unavailable'));
const mockFrequency = jest
  .fn<(...args: unknown[]) => Promise<FrequencyResponse>>()
  .mockResolvedValue(sampleFrequency);

jest.mock('../../../api', () => ({
  practices: {
    listAll: (...args: unknown[]) => mockPracticesList(...args),
    get: jest.fn(),
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
// PracticeScreen installs its header-left drawer toggle through
// useAppNavigation (useScreenDrawer), which calls navigation.setOptions in a
// layout effect on every mount. The store relays the installed headerLeft
// into the same render tree as the screen so the Modal-based drawer opens
// in-tree and its rows are pressable.
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
  useAppRoute: () => ({ key: 'Practice-test', name: 'Practice', params: {} }),
}));

const mockFocusCallbacks: Array<() => void | (() => void)> = [];
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
      createAsync: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        sound: {
          replayAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
          unloadAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
          setOnPlaybackStatusUpdate: jest.fn(),
        },
      }),
    },
  },
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
  useKeepAwake: jest.fn(),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  selectionAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

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

describe('Practice header drawer nav section', () => {
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
    useDepthPreferencesStore.setState({
      enable_habits: true,
      enable_practices: true,
      enable_course: true,
    });
  });

  it("renders the nav section before the drawer's own rows, with a trailing divider", async () => {
    const { getByTestId, getByLabelText, toJSON } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));

    expect(getByTestId('drawer-nav-Practice')).toBeTruthy();
    expect(getByTestId('drawer-nav-divider')).toBeTruthy();

    const json = JSON.stringify(toJSON());
    const navIndex = json.indexOf('"testID":"drawer-nav-Practice"');
    const browseIndex = json.indexOf('"testID":"practice-drawer-browse"');
    expect(navIndex).toBeGreaterThan(-1);
    expect(browseIndex).toBeGreaterThan(-1);
    expect(navIndex).toBeLessThan(browseIndex);
  });

  it('marks the Practice nav row selected', async () => {
    const { getByTestId, getByLabelText } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));

    expect(getByTestId('drawer-nav-Practice').props.accessibilityState.selected).toBe(true);
  });

  it('navigating to a different screen from the nav section closes the drawer', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<PracticeScreenWithHeader />);
    await waitFor(() => expect(getByTestId('practice-empty-state')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Practice menu'));
    fireEvent.press(getByTestId('drawer-nav-Journal'));

    expect(mockRootNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
    expect(queryByTestId('screen-drawer-panel')).toBeNull();
  });
});
