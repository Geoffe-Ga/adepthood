/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Other MapScreen suites always seed 10 cached stages, so the store-driven MapLoading/MapError early returns never render; this file covers those plus a stage with no free-will description.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import styles from '../Map.styles';
import MapScreen, { MAP_LOADING_TIMEOUT_MS } from '../MapScreen';

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

// A never-resolving history keeps the cold-start paths free of async churn.
jest.mock('../../../api', () => ({
  stages: { history: () => new Promise(() => {}) },
}));

type TestNode = { props: Record<string, unknown> };

const LOAD_ERROR_MESSAGE = 'Could not reach the server.';
const TRY_AGAIN = 'Try again';
/** Shortest string the hint line could plausibly be; keeps copy free while still requiring one. */
const MIN_HINT_LENGTH = 8;

/** The slice of a ``toJSON`` node this file reads; the renderer module ships no types. */
interface RenderedNode {
  children: (RenderedNode | string)[] | null;
}

const collectText = (node: RenderedNode | string | null): string[] => {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  return (node.children ?? []).flatMap((child) => collectText(child));
};

const renderedText = (tree: ReturnType<typeof create>): string[] => {
  const rendered = tree.toJSON();
  return (Array.isArray(rendered) ? rendered : [rendered]).flatMap((node) => collectText(node));
};

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
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });
    expect(tree.root.findByProps({ testID: 'map-loading' })).toBeTruthy();
    // The loading state arms a real timer; leaving the tree mounted holds the
    // Jest worker open long after the assertion is done.
    act(() => tree.unmount());
  });

  it('holds the bare spinner for as long as the bounded wait runs', () => {
    // A normal fast load must never flicker the timeout copy on its way past.
    jest.useFakeTimers();
    mockMapState.loading = true;
    mockMapState.stages = [];
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });

    act(() => {
      jest.advanceTimersByTime(MAP_LOADING_TIMEOUT_MS - 1);
    });

    expect(tree.root.findByProps({ testID: 'map-loading' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'map-loading-retry' })).toHaveLength(0);
    act(() => tree.unmount());
    jest.useRealTimers();
  });

  it('offers a way forward once the cold-start spinner outlasts the bounded wait', () => {
    // A GET /stages that never settles used to hold the screen for good:
    // ``loading`` never flips back, so the spinner was the whole app.
    jest.useFakeTimers();
    mockMapState.loading = true;
    mockMapState.stages = [];
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });

    act(() => {
      jest.advanceTimersByTime(MAP_LOADING_TIMEOUT_MS);
    });

    const container = tree.root.findByProps({ testID: 'map-loading-timeout' });
    expect(container.props.accessibilityRole).toBe('alert');
    expect(container.props.accessibilityLiveRegion).toBe('polite');

    const retry = tree.root.findByProps({ testID: 'map-loading-retry' });
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe(TRY_AGAIN);

    expect(mockLoadStages).not.toHaveBeenCalled();
    act(() => retry.props.onPress());
    expect(mockLoadStages).toHaveBeenCalledTimes(1);

    // Retrying puts the spinner back rather than leaving the dead end on screen.
    expect(tree.root.findByProps({ testID: 'map-loading' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'map-loading-timeout' })).toHaveLength(0);
    act(() => tree.unmount());
    jest.useRealTimers();
  });

  it('shows the full-screen error when the load fails with nothing cached', () => {
    mockMapState.error = 'Could not reach the server.';
    mockMapState.stages = [];
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-error' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Could not reach the server.' })).toBeTruthy();
  });

  it('announces the cold-start error and offers a retry that reloads the stages', () => {
    mockMapState.error = LOAD_ERROR_MESSAGE;
    mockMapState.stages = [];
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });

    const container = tree.root.findByProps({ testID: 'map-error' });
    expect(container.props.accessibilityRole).toBe('alert');
    expect(container.props.accessibilityLiveRegion).toBe('polite');

    // A hint line sits alongside the verbatim server message and the button label.
    const hints = renderedText(tree).filter(
      (text) =>
        text !== LOAD_ERROR_MESSAGE && text !== TRY_AGAIN && text.trim().length >= MIN_HINT_LENGTH,
    );
    expect(hints).toHaveLength(1);

    const retry = tree.root.findByProps({ testID: 'map-error-retry' });
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe(TRY_AGAIN);

    // A failed cold start must not re-arm itself: the only load is the user's.
    expect(mockLoadStages).not.toHaveBeenCalled();
    act(() => retry.props.onPress());
    expect(mockLoadStages).toHaveBeenCalledTimes(1);
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
