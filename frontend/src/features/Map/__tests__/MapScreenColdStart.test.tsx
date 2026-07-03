/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Other MapScreen suites always seed 10 cached stages, so the store-driven MapLoading/MapError early returns never render; this file covers those plus a stage with no free-will description.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import styles from '../Map.styles';
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
jest.mock('../services/stageService', () =>
  jest.requireActual('./mapTestHarness').mockStageServiceModule(),
);
jest.mock('../../../store/useStageStore', () =>
  jest.requireActual('./mapTestHarness').mockStageStoreModule(),
);

// A never-resolving history keeps the cold-start paths free of async churn.
jest.mock('../../../api', () => ({
  stages: { history: () => new Promise(() => {}) },
}));

type TestNode = { props: Record<string, unknown> };

describe('MapScreen — cold start and metadata edge cases', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.derivedStage = null;
    mockMapState.derivedWeek = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows the full-screen loader when no stages are cached yet', () => {
    mockMapState.loading = true;
    mockMapState.stages = [];
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-loading' })).toBeTruthy();
  });

  it('shows the full-screen error when the load fails with nothing cached', () => {
    mockMapState.error = 'Could not reach the server.';
    mockMapState.stages = [];
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-error' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Could not reach the server.' })).toBeTruthy();
  });

  it('omits the free-will description line for a stage that has none', () => {
    mockMapState.stages = mockMapState.stages.map((s) =>
      s.stageNumber === 1 ? { ...s, freeWillDescription: '' } : s,
    );
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    expect(
      tree.root.findAll((node: TestNode) => node.props.style === styles.freeWillDescription),
    ).toHaveLength(0);
  });
});
