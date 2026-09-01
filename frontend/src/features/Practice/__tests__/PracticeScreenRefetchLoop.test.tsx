/* global describe, it, expect, beforeEach, afterEach, jest */
// The sibling PracticeScreen suite mocks the stage store, so a stage load that failed
// or came back empty is never observable. This suite keeps the real store and the real
// stage service and mocks only the network, so a re-fetch on the next mount is counted.
import { act, render } from '@testing-library/react-native';
import React from 'react';

import type { Stage } from '../../../api';
import { useStageStore } from '../../../store/useStageStore';
import PracticeScreen from '../PracticeScreen';

const mockListAll = jest.fn<Promise<Stage[]>, [string?]>();

// PracticeScreen reads useSafeAreaInsets and there is no provider in tests.
jest.mock('react-native-safe-area-context', () => {
  const ReactMod = jest.requireActual('react');
  const passthrough = ({ children }: { children: unknown }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

// Only the network boundary is mocked. The practice endpoints resolve to nothing so the
// screen settles on its empty state; the calendar rejects because ``loadStages`` swallows
// that failure by design.
jest.mock('../../../api', () => ({
  stages: {
    listAll: (...args: [string?]) => mockListAll(...args),
    programCalendar: () => Promise.reject(new Error('calendar unavailable in tests')),
  },
  practices: {
    listAll: () => Promise.resolve([]),
  },
  userPractices: {
    list: () => Promise.resolve([]),
    create: () => Promise.reject(new Error('create unused in tests')),
    customize: () => Promise.reject(new Error('customize unused in tests')),
  },
  practiceSessions: {
    insights: () => Promise.reject(new Error('insights unavailable in tests')),
    weekCount: () => Promise.resolve({ count: 0 }),
    create: () => Promise.reject(new Error('session create unused in tests')),
  },
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

jest.mock('../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
  useAppRoute: () => ({ key: 'Practice-test', name: 'Practice', params: {} }),
}));

jest.mock('@react-navigation/native', () => {
  const reactMod = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    ...(jest.requireActual('@react-navigation/native') as object),
    useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
    useRoute: () => ({ key: 'Practice-test', name: 'Practice', params: {} }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      reactMod.useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
      }, [cb]);
    },
  };
});

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    seekTo: jest.fn(),
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

/** Bounded on purpose: on today's code the loader re-arms itself, so an unbounded waitFor never settles. */
const FLUSH_ROUNDS = 8;
const STAGE_TOTAL = 10;
const LOAD_ERROR_MESSAGE = 'Could not reach the server.';

const makeWireStage = (stageNumber: number): Stage => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: `Subtitle ${stageNumber}`,
  stage_number: stageNumber,
  overview_url: '',
  category: 'Test',
  aspect: 'Aspect',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Growing',
  divine_gender_polarity: 'Divine Feminine',
  relationship_to_free_will: 'Free Will',
  free_will_description: `Free will at stage ${stageNumber}.`,
  is_unlocked: stageNumber === 1,
  progress: 0,
  manifestations: [],
});

const wireStages = (): Stage[] =>
  Array.from({ length: STAGE_TOTAL }, (_, index) => makeWireStage(index + 1));

let mounted: ReturnType<typeof render> | null = null;

const renderPractice = (): ReturnType<typeof render> => {
  // ``render`` wraps its own act; nesting another act around it breaks the renderer handle.
  const tree = render(<PracticeScreen />);
  mounted = tree;
  return tree;
};

const unmountPractice = (tree: ReturnType<typeof render>): void => {
  if (mounted === tree) mounted = null;
  act(() => tree.unmount());
};

// The drain deliberately lets background loads settle outside ``act``, so React's
// legacy act environment is switched off for its duration and restored after.
const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Advance a fixed number of task turns so a refetch storm is counted rather than awaited. */
const flushRounds = async (): Promise<void> => {
  const previous = actEnv.IS_REACT_ACT_ENVIRONMENT;
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    for (let round = 0; round < FLUSH_ROUNDS; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      act(() => {});
    }
  } finally {
    actEnv.IS_REACT_ACT_ENVIRONMENT = previous;
  }
};

describe('PracticeScreen — the stage cold-start fetch is not a per-mount loop', () => {
  beforeEach(() => {
    // The real store is a module-level singleton, so it must be wiped between tests.
    useStageStore.getState().reset();
    mockListAll.mockReset();
  });

  // Unmount before the next test resets the shared store, so a stale subscriber
  // cannot re-render off another test's state.
  afterEach(() => {
    const tree = mounted;
    mounted = null;
    if (tree !== null) act(() => tree.unmount());
  });

  it('fetches the stage list exactly once on a cold mount', async () => {
    mockListAll.mockResolvedValue(wireStages());

    renderPractice();
    await flushRounds();

    expect(mockListAll).toHaveBeenCalledTimes(1);
  });

  it('does not fetch the stage list again on a remount after a failed load', async () => {
    mockListAll.mockRejectedValue(new Error(LOAD_ERROR_MESSAGE));

    const first = renderPractice();
    await flushRounds();
    expect(mockListAll).toHaveBeenCalledTimes(1);

    unmountPractice(first);

    renderPractice();
    await flushRounds();

    // The invariant: one automatic attempt per session; a failure is not a licence
    // to re-ask on every visit to Practice.
    expect(mockListAll).toHaveBeenCalledTimes(1);
  });

  it('does not fetch the stage list again on a remount after an empty success', async () => {
    mockListAll.mockResolvedValue([]);

    const first = renderPractice();
    await flushRounds();
    expect(mockListAll).toHaveBeenCalledTimes(1);

    unmountPractice(first);

    renderPractice();
    await flushRounds();

    // A load that succeeds with nothing leaves the store back at its guard-passing
    // shape, so only a recorded attempt can stop the next mount re-asking.
    expect(mockListAll).toHaveBeenCalledTimes(1);
  });

  it('a logout reset re-arms the Practice cold-start fetch', async () => {
    mockListAll.mockResolvedValue([]);

    const first = renderPractice();
    await flushRounds();
    expect(mockListAll).toHaveBeenCalledTimes(1);

    unmountPractice(first);
    act(() => useStageStore.getState().reset());

    renderPractice();
    await flushRounds();

    expect(mockListAll).toHaveBeenCalledTimes(2);
  });
});
