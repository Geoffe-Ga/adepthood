/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

import type { StageHistoryData } from './mapTestHarness';
import { resetMapMocks } from './mapTestHarness';

jest.mock('../../../navigation/hooks', () =>
  jest.requireActual('./mapTestHarness').mockNavigationModule(),
);
jest.mock('@react-navigation/bottom-tabs', () =>
  jest.requireActual('./mapTestHarness').mockBottomTabsModule(),
);
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('./mapTestHarness').mockSafeAreaModule(),
);
jest.mock('../services/stageService', () =>
  jest.requireActual('./mapTestHarness').mockStageServiceModule(),
);
jest.mock('../../../store/useStageStore', () =>
  jest.requireActual('./mapTestHarness').mockStageStoreModule(),
);

const mockHistoryFn = jest.fn<Promise<StageHistoryData>, [number, string?]>();
jest.mock('../../../api', () => ({
  stages: {
    history: (...args: [number, string?]) => mockHistoryFn(...args),
  },
}));

const HISTORY_WITH_DATA: StageHistoryData = {
  stage_number: 1,
  practices: [
    {
      name: 'Breath of Fire',
      sessions_completed: 12,
      total_minutes: 180,
      last_session: '2026-03-15T10:30:00Z',
    },
  ],
  habits: [
    {
      name: 'Morning Exercise',
      icon: '🏃',
      goals_achieved: { low: true, clear: true, stretch: false },
      best_streak: 14,
      total_completions: 45,
    },
  ],
};

const EMPTY_HISTORY: StageHistoryData = {
  stage_number: 1,
  practices: [],
  habits: [],
};

describe('MapScreen — Stage History', () => {
  beforeEach(() => {
    resetMapMocks();
    mockHistoryFn.mockReset();
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows history section for unlocked stages', () => {
    const tree = create(<MapScreen />);
    // Open modal for stage 1 (unlocked)
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const section = tree.root.findByProps({ testID: 'history-section' });
    expect(section).toBeTruthy();
  });

  it('does not show history section for locked stages', () => {
    const tree = create(<MapScreen />);
    // Open modal for stage 3 (locked in our test data)
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress();
    });
    const sections = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'history-section',
    );
    expect(sections.length).toBe(0);
  });

  it('shows empty state message for stages with no activity', async () => {
    mockHistoryFn.mockResolvedValueOnce(EMPTY_HISTORY);
    const tree = create(<MapScreen />);

    // Open modal and expand history
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    const empty = tree.root.findByProps({ testID: 'history-empty' });
    expect(empty).toBeTruthy();
    expect(empty.props.children).toContain('Begin this stage');
  });

  it('renders practice and habit history items when expanded', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    const content = tree.root.findByProps({ testID: 'history-content' });
    expect(content).toBeTruthy();

    // Practice items — findAll may return duplicates from deep traversal
    const practiceItems = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'practice-history-item',
    );
    expect(practiceItems.length).toBeGreaterThanOrEqual(1);

    // Habit items
    const habitItems = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'habit-history-item',
    );
    expect(habitItems.length).toBeGreaterThanOrEqual(1);
  });

  it('renders goal tier badges for habits', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    // Should have 3 goal badges (low, clear, stretch)
    const badges = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('goal-badge-'),
    );
    // Deep traversal may find duplicates; at minimum 3 unique tiers
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it('lazy loads history data only when expanded', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    // Open modal — history API should NOT be called yet
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    expect(mockHistoryFn).not.toHaveBeenCalled();

    // Expand history — NOW it should fetch
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    expect(mockHistoryFn).toHaveBeenCalledWith(1);
  });

  it('shows the history loading spinner before the fetch resolves', async () => {
    let resolveHistory: ((_v: StageHistoryData) => void) | undefined;
    mockHistoryFn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const tree = create(<MapScreen />);

    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'history-loading' })).toBeTruthy();

    await act(async () => {
      resolveHistory?.(EMPTY_HISTORY);
    });
  });

  it('does not refetch on collapse then re-expand once history has already loaded', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    expect(mockHistoryFn).toHaveBeenCalledTimes(1);

    // Collapse — the history content leaves the tree.
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    const collapsed = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'history-content',
    );
    expect(collapsed.length).toBe(0);

    // Re-expand — the already-loaded history renders without a second fetch.
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    expect(mockHistoryFn).toHaveBeenCalledTimes(1);
    expect(tree.root.findByProps({ testID: 'history-content' })).toBeTruthy();
  });
});
