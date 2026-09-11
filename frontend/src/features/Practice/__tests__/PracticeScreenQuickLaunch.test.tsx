/* eslint-env jest */
/**
 * The quick launch, as the writer meets it: a button in the player region that
 * exists only for a saved ``Journaling`` practice, and that lands them on a
 * dated journal page with the practice's own length already running.
 *
 * Driven through the whole screen rather than through the button alone. The
 * decision it renders is pure and tested next to ``planQuickLaunch``; what only
 * this file can catch is the screen failing to ask that question, or asking it
 * with the wrong practice, or navigating with something other than the answer —
 * which is what a button that renders perfectly and does nothing looks like.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem, UserPractice } from '../../../api';
import { useStageStore } from '../../../store/useStageStore';
import PracticeScreen from '../PracticeScreen';

/**
 * Every case here mounts the whole player — the ritual engine, its audio and
 * haptics adapters, the identity header and the weekly footer — so a single
 * render costs seconds, and the five-second default is a flake as soon as the
 * suite shares a machine with the rest of the frontend run rather than a real
 * assertion about how fast the screen is. Mirrors ``PracticeCatalogScreen``'s
 * own allowance, for the same reason.
 */
jest.setTimeout(30_000);

/** Green, where the seeded ``Journaling`` row sits. */
const GREEN = 6;
/** What the seeder gives the ``Journaling`` row: count_up, twenty nominal minutes. */
const SEEDED_MINUTES = 20;
const SELECTION_ID = 91;
/**
 * Generous, because this screen mounts the whole ritual engine and its adapters
 * on every case: the default one-second wait is a flake on a loaded machine, and
 * a settle that never happens still fails, just later.
 */
const SETTLE_TIMEOUT_MS = 10_000;

const journaling: PracticeItem = {
  id: 5,
  stage_number: GREEN,
  name: 'Journaling',
  description: 'Open-ended writing with no subject set in advance.',
  instructions: 'Write without steering.',
  default_duration_minutes: SEEDED_MINUTES,
  approved: true,
  mode: 'count_up',
  mode_config: { mode: 'count_up', soft_cap_minutes: null },
};

const somethingElse: PracticeItem = {
  ...journaling,
  id: 6,
  name: 'Loving-kindness',
  mode: 'meditation_timer',
  mode_config: { mode: 'meditation_timer', duration_minutes: 15 },
};

const openSelection = (practice: PracticeItem, overrides: Partial<UserPractice> = {}) => ({
  id: SELECTION_ID,
  practice_id: practice.id,
  stage_number: GREEN,
  start_date: '2026-09-01',
  end_date: null,
  ...overrides,
});

const mockPracticesList = jest.fn<() => Promise<PracticeItem[]>>();
const mockUserPracticesList = jest.fn<() => Promise<UserPractice[]>>();
const mockRootNavigate = jest.fn();
let mockUserTimezone = 'UTC';

jest.mock('react-native-safe-area-context', () => {
  // Structurally typed rather than `typeof import('react')`: a jest.mock
  // factory may not close over the file's own React import, and the repo bans
  // inline `import()` type annotations.
  const ReactMod = jest.requireActual('react') as {
    createElement: (_type: unknown, _props: unknown, _children: unknown) => unknown;
    Fragment: unknown;
  };
  const passthrough = ({ children }: { children: unknown }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

jest.mock('../../../api', () => ({
  stages: {
    listAll: () => Promise.resolve([]),
    programCalendar: () => Promise.reject(new Error('calendar unused in this suite')),
  },
  practices: {
    listAll: () => mockPracticesList(),
    get: () => Promise.reject(new Error('get unused in this suite')),
  },
  userPractices: {
    list: () => mockUserPracticesList(),
    create: () => Promise.reject(new Error('create unused in this suite')),
    customize: () => Promise.reject(new Error('customize unused in this suite')),
  },
  practiceSessions: {
    create: () => Promise.reject(new Error('session create unused in this suite')),
    weekCount: () => Promise.resolve({ count: 0 }),
    insights: () => Promise.reject(new Error('insights unavailable in this suite')),
  },
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: mockUserTimezone }),
}));

const mockRouteParams: Record<string, unknown> = { stageNumber: GREEN };
jest.mock('../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
  useAppRoute: () => ({ key: 'Practice-test', name: 'Practice', params: mockRouteParams }),
}));

jest.mock('@react-navigation/native', () => {
  const reactMod = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    ...(jest.requireActual('@react-navigation/native') as object),
    useNavigation: () => ({ navigate: mockRootNavigate, goBack: jest.fn() }),
    useRoute: () => ({ key: 'Practice-test', name: 'Practice', params: mockRouteParams }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      reactMod.useEffect(() => cb() as undefined | (() => void), [cb]);
    },
  };
});

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    seekTo: jest.fn(() => Promise.resolve()),
    play: jest.fn(),
    remove: jest.fn(),
  })),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: jest.fn(),
  useKeepAwake: jest.fn(),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: () => Promise.resolve(),
  selectionAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

beforeEach(() => {
  mockRootNavigate.mockReset();
  mockPracticesList.mockReset();
  mockUserPracticesList.mockReset();
  mockUserTimezone = 'UTC';
  act(() => {
    useStageStore.getState().reset();
    useStageStore.getState().setCurrentStage(GREEN);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

async function renderPlayer() {
  const view = render(<PracticeScreen />);
  await waitFor(() => expect(view.queryByTestId('practice-loading')).toBeNull(), {
    timeout: SETTLE_TIMEOUT_MS,
  });
  return view;
}

describe('the Practice player’s quick launch into a timed page', () => {
  it('offers nothing when the practice at this stage is not Journaling', async () => {
    mockPracticesList.mockResolvedValue([somethingElse]);
    mockUserPracticesList.mockResolvedValue([openSelection(somethingElse)]);

    const { queryByTestId } = await renderPlayer();

    expect(queryByTestId('practice-quick-launch')).toBeNull();
  });

  it('offers nothing when no practice is set for the stage at all', async () => {
    mockPracticesList.mockResolvedValue([journaling]);
    mockUserPracticesList.mockResolvedValue([]);

    const { queryByTestId } = await renderPlayer();

    expect(queryByTestId('practice-quick-launch')).toBeNull();
  });

  it('offers a timed page once Journaling is the writer’s practice here', async () => {
    mockPracticesList.mockResolvedValue([journaling]);
    mockUserPracticesList.mockResolvedValue([openSelection(journaling)]);

    const { getByTestId, getByText, queryByTestId } = await renderPlayer();

    expect(getByTestId('practice-quick-launch')).toBeTruthy();
    expect(getByText('Begin a timed page')).toBeTruthy();
    expect(queryByTestId('practice-quick-launch-waiting')).toBeNull();
  });

  it('opens today’s titled page with the practice’s own length already running', async () => {
    mockUserTimezone = 'America/Los_Angeles';
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T01:00:00.000Z'));
    mockPracticesList.mockResolvedValue([journaling]);
    mockUserPracticesList.mockResolvedValue([openSelection(journaling)]);

    const { getByTestId } = await renderPlayer();
    fireEvent.press(getByTestId('practice-quick-launch'));

    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('JournalEntry', {
      writingSession: { minutes: SEEDED_MINUTES, userPracticeId: SELECTION_ID },
      prefillTitle: '2026-09-10 Daily Journal',
    });
  });

  /** The #933 guard, at the surface a writer actually taps. */
  it('carries the length the writer edited, not the catalogue’s', async () => {
    mockPracticesList.mockResolvedValue([journaling]);
    mockUserPracticesList.mockResolvedValue([
      openSelection(journaling, {
        mode_config_override: { mode: 'count_up', soft_cap_minutes: 45 },
        effective_config: { mode: 'count_up', soft_cap_minutes: 45 },
      }),
    ]);

    const { getByTestId } = await renderPlayer();
    fireEvent.press(getByTestId('practice-quick-launch'));

    expect(mockRootNavigate).toHaveBeenCalledWith('JournalEntry', {
      writingSession: { minutes: 45, userPracticeId: SELECTION_ID },
      prefillTitle: expect.stringMatching(/^\d{4}-\d{2}-\d{2} Daily Journal$/),
    });
  });
});

describe('the quick launch for a stage the writer has not reached', () => {
  beforeEach(() => {
    act(() => {
      useStageStore.getState().setCurrentStage(1);
    });
  });

  /**
   * The page is never withheld — it is the floor of the product. What changes is
   * that the launch carries no selection to count against, and the writer is
   * told so before they tap rather than after a 403 they cannot see.
   */
  it('still offers the page, and says plainly that it is not counted yet', async () => {
    mockPracticesList.mockResolvedValue([journaling]);
    mockUserPracticesList.mockResolvedValue([openSelection(journaling)]);

    const { getByTestId } = await renderPlayer();

    expect(getByTestId('practice-quick-launch')).toBeTruthy();
    expect(getByTestId('practice-quick-launch-waiting')).toBeTruthy();

    fireEvent.press(getByTestId('practice-quick-launch'));

    expect(mockRootNavigate).toHaveBeenCalledWith('JournalEntry', {
      writingSession: { minutes: SEEDED_MINUTES, userPracticeId: null },
      prefillTitle: expect.stringMatching(/^\d{4}-\d{2}-\d{2} Daily Journal$/),
    });
  });
});
