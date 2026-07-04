/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

import type { StageHistoryData } from './mapTestHarness';
import { mockMakeStage, mockMapState, mockNavigate, resetMapMocks } from './mapTestHarness';

import { showcase } from '@/design/tokens';

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

// Reduced-motion-safe path: no Animated pulse (Animated trips the test
// renderer's InteractionManager). Asserts the celebration still renders at rest.
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

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
  stages: {
    history: (...args: [number, string?]) => mockHistoryFn(...args),
  },
}));

const findText = (tree: ReturnType<typeof create>, fragment: string): boolean =>
  tree.root.findAll(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) =>
      typeof node.props.children === 'string' && node.props.children.includes(fragment),
  ).length > 0;

// The first tap on a non-focused stage sends the magnifier lens gliding there;
// the second tap (now on the focused stage) opens the detail modal. Pressing
// twice is idempotent when the stage is already focused.
const openStage = (tree: ReturnType<typeof create>, stageNumber: number): void => {
  act(() => {
    tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-0` }).props.onPress();
  });
  act(() => {
    tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-0` }).props.onPress();
  });
};

const GRID_LAYOUT = { width: 300, height: 600 };

/** Report a measured grid size so the wave overlay + magnifier lens mount. */
const fireGridLayout = (tree: ReturnType<typeof create>): void => {
  act(() => {
    tree.root.findByProps({ testID: 'map-grid' }).props.onLayout({
      nativeEvent: { layout: GRID_LAYOUT },
    });
  });
};

describe('MapScreen — journey narrative', () => {
  beforeEach(() => {
    resetMapMocks();
    mockHistoryFn.mockReset();
    mockMapState.derivedStage = 5;
    mockMapState.derivedWeek = 12;
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, { color: '#abcdef' }),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders the compact journey read "Stage N of 10 · Week W"', () => {
    const tree = create(<MapScreen />);
    const read = tree.root.findByProps({ testID: 'journey-read' });
    expect(read).toBeTruthy();
    expect(findText(tree, 'Stage 5 of 10 · Week 12')).toBe(true);
  });

  it('marks the current stage with the you-are-here chip riding the magnifier lens', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    const lens = tree.root.findByProps({ testID: 'map-magnifier' });
    expect(lens.findByProps({ testID: 'you-are-here' })).toBeTruthy();
    expect(findText(tree, 'YOU ARE HERE')).toBe(true);
  });

  it('shows an "Unlocks in N days" timeline on a locked stage', () => {
    // Calendar at stage 5, so stage 8 is locked.
    mockMapState.daysUntilStage = 9;
    const tree = create(<MapScreen />);
    const unlock = tree.root.findByProps({ testID: 'stage-unlock-8' });
    expect(unlock).toBeTruthy();
    expect(findText(tree, 'Unlocks in 9 days')).toBe(true);
  });

  it('grounds the detail modal on the showcase surface tinted with the stage colour', () => {
    const tree = create(<MapScreen />);
    openStage(tree, 1);
    const modal = tree.root.findByProps({ testID: 'stage-modal' });
    const flat = Array.isArray(modal.props.style)
      ? Object.assign({}, ...modal.props.style.filter(Boolean))
      : modal.props.style;
    expect(flat.backgroundColor).toBe(showcase.canvas);
    expect(flat.borderLeftColor).toBe('#abcdef');
  });

  it('renders a one-sentence history + ranked stats + retained medals', async () => {
    mockHistoryFn.mockResolvedValueOnce({
      stage_number: 1,
      practices: [
        { name: 'Breath', sessions_completed: 12, total_minutes: 180, last_session: null },
      ],
      habits: [
        {
          name: 'Exercise',
          icon: '🏃',
          goals_achieved: { low: true, clear: true, stretch: false },
          best_streak: 14,
          total_completions: 45,
        },
      ],
    });
    const tree = create(<MapScreen />);
    openStage(tree, 1);
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'progression-sentence' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'ranked-stats' })).toBeTruthy();
    // One progression sentence.
    expect(findText(tree, 'You logged 12 sessions')).toBe(true);
    // Medals retained.
    const badges = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('goal-badge-'),
    );
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it('ranks the modal actions into a primary Continue + two secondary, all wired', () => {
    const tree = create(<MapScreen />);
    openStage(tree, 1);

    // Primary action keeps the practice-link handler but reads "Continue".
    expect(findText(tree, 'Continue')).toBe(true);
    act(() => tree.root.findByProps({ testID: 'practice-link' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Practice', { stageNumber: 1 });

    // Each action closes the modal on navigate, so reopen between presses; the
    // two secondary actions remain wired to Course / Journal.
    openStage(tree, 1);
    act(() => tree.root.findByProps({ testID: 'course-link' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Course', { stageNumber: 1 });

    openStage(tree, 1);
    act(() => tree.root.findByProps({ testID: 'journal-link' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Journal', {
      tag: 'stage_reflection',
      stageNumber: 1,
    });
  });

  it('plays the Celebration when a stage newly completes', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });
    // No celebration on first paint (baseline seeded).
    const celebrations = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (n: any) => n.props.testID === 'stage-celebration',
    );
    expect(celebrations.length).toBe(0);

    // Stage 3 completes → re-render with the new progress.
    mockMapState.stages = mockMapState.stages.map((s) =>
      s.stageNumber === 3 ? { ...s, progress: 1 } : s,
    );
    act(() => {
      tree.update(<MapScreen />);
    });

    const celebration = tree.root.findByProps({ testID: 'stage-celebration' });
    expect(celebration).toBeTruthy();
    // Names the next stage that unlocked.
    expect(findText(tree, 'Stage 4 unlocked')).toBe(true);
    act(() => tree.unmount());
  });
});
