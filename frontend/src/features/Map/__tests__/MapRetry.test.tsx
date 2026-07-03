/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// audit-ux-03: a failed map refresh (with cached stages) must surface a retry
// banner instead of silently showing stale data, and a failed history fetch must
// render an error+retry distinct from the genuinely-empty state.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

import type { StageHistoryData } from './mapTestHarness';
import { mockLoadStages, mockMapState, resetMapMocks } from './mapTestHarness';

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

const mockHistoryFn = jest.fn<Promise<StageHistoryData>, [number, string?]>();
jest.mock('../../../api', () => ({
  stages: { history: (...args: [number, string?]) => mockHistoryFn(...args) },
}));

const EMPTY_HISTORY: StageHistoryData = { stage_number: 1, practices: [], habits: [] };

const countByTestId = (tree: ReturnType<typeof create>, testID: string): number =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree.root.findAll((node: any) => node.props.testID === testID).length;

describe('MapScreen — refresh retry', () => {
  beforeEach(() => {
    resetMapMocks();
    mockHistoryFn.mockReset();
    mockMapState.derivedStage = null;
    mockMapState.derivedWeek = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows a retry banner when a refresh fails while stages are cached', () => {
    mockMapState.error = 'Network error';
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-refresh-error' })).toBeTruthy();
    const retry = tree.root.findByProps({ testID: 'map-refresh-retry' });

    act(() => retry.props.onPress());
    expect(mockLoadStages).toHaveBeenCalledTimes(1);
  });

  it('does not show the refresh banner when there is no error', () => {
    const tree = create(<MapScreen />);
    expect(countByTestId(tree, 'map-refresh-error')).toBe(0);
  });
});

describe('MapScreen — stage history error vs empty', () => {
  beforeEach(() => {
    resetMapMocks();
    mockHistoryFn.mockReset();
    mockMapState.derivedStage = null;
    mockMapState.derivedWeek = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders an error+retry (not the empty copy) when the history fetch fails', async () => {
    mockHistoryFn.mockRejectedValueOnce(new Error('boom'));
    const tree = create(<MapScreen />);
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'history-error' })).toBeTruthy();
    expect(countByTestId(tree, 'history-empty')).toBe(0);

    // Retry re-runs the fetch; this time it resolves empty → empty copy shows.
    mockHistoryFn.mockResolvedValueOnce(EMPTY_HISTORY);
    await act(async () => {
      tree.root.findByProps({ testID: 'history-retry' }).props.onPress();
    });
    expect(mockHistoryFn).toHaveBeenCalledTimes(2);
    expect(tree.root.findByProps({ testID: 'history-empty' })).toBeTruthy();
    expect(countByTestId(tree, 'history-error')).toBe(0);
  });

  it('still shows the empty copy for a genuinely empty history', async () => {
    mockHistoryFn.mockResolvedValueOnce(EMPTY_HISTORY);
    const tree = create(<MapScreen />);
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'history-empty' })).toBeTruthy();
    expect(countByTestId(tree, 'history-error')).toBe(0);
  });
});
