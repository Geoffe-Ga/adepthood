/* eslint-env jest */
/* global describe, it, expect, beforeEach, afterEach, jest */
// The sibling MapScreen suites mock both the stage store and the stage service, so a
// failed cold-start load never flips real loading/error state. This suite keeps both
// real and mocks only the network, making the fetch effect's re-entry observable.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import type { Stage } from '../../../api';
import { useStageStore } from '../../../store/useStageStore';
import MapScreen from '../MapScreen';

import { mockMapState, resetMapMocks } from './mapTestHarness';

jest.mock('react-native/Libraries/Interaction/InteractionManager', () =>
  jest.requireActual('./mapTestHarness').mockInteractionManagerModule(),
);
jest.mock('../../../navigation/hooks', () =>
  jest.requireActual('./mapTestHarness').mockNavigationModule(),
);
jest.mock('@react-navigation/bottom-tabs', () =>
  jest.requireActual('./mapTestHarness').mockBottomTabsModule(),
);
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('./mapTestHarness').mockSafeAreaModule(),
);
jest.mock('../../../store/useProgramProgression', () =>
  jest.requireActual('./mapTestHarness').mockProgramProgressionModule(),
);
// The real wheel hook reads a ``wheel`` client this suite's stages-only api mock omits.
jest.mock('../hooks/useWheelBalance', () =>
  jest.requireActual('./mapTestHarness').mockWheelBalanceModule(),
);

const mockListAll = jest.fn<Promise<Stage[]>, [string?]>();

// Only the network boundary is mocked. A never-resolving history keeps the suite free of
// async churn; the calendar rejects because ``loadStages`` swallows that failure by design.
jest.mock('../../../api', () => ({
  stages: {
    listAll: (...args: [string?]) => mockListAll(...args),
    history: () => new Promise(() => {}),
    programCalendar: () => Promise.reject(new Error('calendar unavailable in tests')),
    beginAgain: () => Promise.reject(new Error('begin-again unused in tests')),
  },
}));

/** Bounded on purpose: on today's code the loader re-arms itself, so an unbounded waitFor never settles. */
const FLUSH_ROUNDS = 8;
const STAGE_TOTAL = 10;
const LOAD_ERROR_MESSAGE = 'Could not reach the server.';
const IMAGE_WIDTH = 100;
const IMAGE_HEIGHT = 200;

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

let mounted: ReturnType<typeof create> | null = null;

const renderMap = (): ReturnType<typeof create> => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<MapScreen />);
  });
  mounted = tree;
  return tree;
};

// The drain deliberately lets background loads settle outside ``act``, so React's
// legacy act environment is switched off for its duration and restored after.
const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Advance a fixed number of task turns so a retry storm is counted rather than awaited. */
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

describe('MapScreen — cold-start fetch is not a retry loop', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.derivedStage = null;
    mockMapState.derivedWeek = null;
    // The real store is a module-level singleton, so it must be wiped between tests.
    useStageStore.getState().reset();
    mockListAll.mockReset();
    jest
      .spyOn(Image, 'getSize')
      .mockImplementation((_, success) => success(IMAGE_WIDTH, IMAGE_HEIGHT));
  });

  // Unmount before the next test resets the shared store, so a stale subscriber
  // cannot re-render off another test's state.
  afterEach(() => {
    const tree = mounted;
    mounted = null;
    if (tree !== null) act(() => tree.unmount());
  });

  it('fetches the stage list exactly once when the cold-start load succeeds', async () => {
    mockListAll.mockResolvedValue(wireStages());

    const tree = renderMap();
    await flushRounds();

    expect(mockListAll).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({ testID: 'map-error' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'journey-read' })).toBeTruthy();
  });

  it('fetches the stage list exactly once when the load keeps failing', async () => {
    mockListAll.mockRejectedValue(new Error(LOAD_ERROR_MESSAGE));

    const tree = renderMap();
    await flushRounds();

    // The invariant: one automatic attempt on cold start; every further attempt is user-initiated.
    expect(mockListAll).toHaveBeenCalledTimes(1);
    expect(tree.root.findByProps({ testID: 'map-error' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'map-error-retry' })).toBeTruthy();
  });

  it('recovers through the error retry, which is the only second fetch', async () => {
    mockListAll
      .mockRejectedValueOnce(new Error(LOAD_ERROR_MESSAGE))
      .mockResolvedValue(wireStages());

    const tree = renderMap();
    await flushRounds();

    const retry = tree.root.findByProps({ testID: 'map-error-retry' });
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe('Try again');

    act(() => retry.props.onPress());
    await flushRounds();

    expect(tree.root.findAllByProps({ testID: 'map-error' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'journey-read' })).toBeTruthy();
    expect(mockListAll).toHaveBeenCalledTimes(2);
  });
});
