/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Integration suite for the Map header drawer wired into MapScreen: the
// header-left toggle installs via useScreenDrawer, opening it renders the
// stage legend, and tapping a row closes the drawer, moves the magnifier
// lens's focus to the tapped stage, AND opens the stage-detail modal for that
// stage (locked or not, since the harness loads all ten stages). Mirrors
// MapScreen.test.tsx's mock setup so the same harness-driven
// stages/wheel/progression state applies.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

import { mockMakeStage, mockMapState, mockSetOptions, resetMapMocks } from './mapTestHarness';

jest.mock('react-native/Libraries/Interaction/InteractionManager', () =>
  jest.requireActual('./mapTestHarness').mockInteractionManagerModule(),
);
jest.mock('../../../navigation/hooks', () =>
  jest.requireActual('./mapTestHarness').mockNavigationModule(),
);
// The drawer nav section dispatches through the root stack via useNavigation;
// stub it so MapScreen renders outside a real NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock('@react-navigation/bottom-tabs', () =>
  jest.requireActual('./mapTestHarness').mockBottomTabsModule(),
);
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('./mapTestHarness').mockSafeAreaModule(),
);
jest.mock('../hooks/useWheelBalance', () =>
  jest.requireActual('./mapTestHarness').mockWheelBalanceModule(),
);
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

type TestNode = { props: Record<string, unknown> };
type HeaderLeftOptions = { headerLeft?: () => React.ReactElement };

const WAVE_LAYOUT_WIDTH = 300;
const WAVE_LAYOUT_HEIGHT = 600;

const fireGridLayout = (tree: ReturnType<typeof create>): void => {
  act(() => {
    tree.root.findByProps({ testID: 'map-grid' }).props.onLayout({
      nativeEvent: { layout: { width: WAVE_LAYOUT_WIDTH, height: WAVE_LAYOUT_HEIGHT } },
    });
  });
};

/** Grab the most recently installed headerLeft toggle element. */
const lastHeaderLeftToggle = (): React.ReactElement => {
  const calls = mockSetOptions.mock.calls;
  const lastCall = calls[calls.length - 1] as [HeaderLeftOptions] | undefined;
  if (!lastCall) throw new Error('setOptions was never called');
  const headerLeft = lastCall[0].headerLeft;
  if (!headerLeft) throw new Error('headerLeft was not installed');
  return headerLeft();
};

/** Press the installed header-left toggle to open the drawer in-tree. */
const openDrawer = (): void => {
  const toggle = lastHeaderLeftToggle();
  act(() => {
    (toggle.props as { onPress: () => void }).onPress();
  });
};

describe('MapScreen header drawer', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('installs a header-left drawer toggle via useScreenDrawer', () => {
    const tree = create(<MapScreen />);
    expect(mockSetOptions).toHaveBeenCalled();
    const toggle = lastHeaderLeftToggle();
    // headerLeft returns an unrendered DrawerToggle element; its label lives on
    // the TouchableOpacity it renders, so render it to assert the Map label.
    let rendered: ReturnType<typeof create> | undefined;
    act(() => {
      rendered = create(toggle);
    });
    expect(rendered?.root.findByProps({ accessibilityLabel: 'Open Map menu' })).toBeTruthy();
    act(() => rendered?.unmount());
    act(() => tree.unmount());
  });

  it('renders the stage legend once the drawer toggle is pressed', () => {
    const tree = create(<MapScreen />);
    openDrawer();
    expect(tree.root.findByProps({ testID: 'map-drawer' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'map-drawer-stage-1' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'map-drawer-stage-10' })).toBeTruthy();
  });

  it('installs the toggle but keeps the drawer unrendered until pressed', () => {
    const tree = create(<MapScreen />);
    expect(mockSetOptions).toHaveBeenCalled();
    expect(() => tree.root.findByProps({ testID: 'map-drawer' })).toThrow();
  });

  it('tapping a drawer row closes the drawer and moves the lens focus to that stage', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    openDrawer();

    act(() => {
      tree.root.findByProps({ testID: 'map-drawer-stage-3' }).props.onPress();
    });

    // Closing unmounts the drawer body (the Modal renders null when hidden).
    expect(() => tree.root.findByProps({ testID: 'map-drawer' })).toThrow();
    // The lens headline reflects the newly focused stage (stage 3's arrow label).
    const headline = tree.root.findByProps({ testID: 'magnifier-headline' });
    expect(headline.props.children).toBe('Self-Love');
  });

  it('tapping a locked drawer row still closes the drawer and refocuses the lens', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    openDrawer();

    act(() => {
      tree.root.findByProps({ testID: 'map-drawer-stage-8' }).props.onPress();
    });

    // Closing unmounts the drawer body (the Modal renders null when hidden).
    expect(() => tree.root.findByProps({ testID: 'map-drawer' })).toThrow();
    // The lens headline reflects the newly focused stage (stage 8's arrow label).
    const headline = tree.root.findByProps({ testID: 'magnifier-headline' });
    expect(headline.props.children).toBe('True Self');
  });

  it('opens the stage-detail modal for the tapped stage, and closes the drawer', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    openDrawer();

    act(() => {
      tree.root.findByProps({ testID: 'map-drawer-stage-3' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'stage-modal' })).toBeTruthy();
    expect(() => tree.root.findByProps({ testID: 'map-drawer' })).toThrow();
  });

  it('opens the stage-detail modal even for a locked drawer row', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    openDrawer();

    act(() => {
      tree.root.findByProps({ testID: 'map-drawer-stage-8' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'stage-modal' })).toBeTruthy();
  });

  it('reflects the current cycle number in the drawer journey summary', () => {
    // The top JourneyHeader also renders "Cycle 2" (testID cycle-indicator);
    // scope the assertion to the drawer body so it pins the drawer's own copy.
    mockMapState.cycleNumber = 2;
    const tree = create(<MapScreen />);
    openDrawer();
    const drawer = tree.root.findByProps({ testID: 'map-drawer' });
    const found = drawer.findAll((n: TestNode) => n.props.children === 'Cycle 2');
    expect(found.length).toBeGreaterThan(0);
  });
});
