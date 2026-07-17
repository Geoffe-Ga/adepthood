/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// RED coverage for the shared DrawerNavSection wired into the Map header
// drawer. Mirrors MapScreenDrawer.test.tsx's harness.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

import { mockMakeStage, mockMapState, mockSetOptions, resetMapMocks } from './mapTestHarness';

const mockRootNavigate = jest.fn();
// The drawer now dispatches through the root stack, not the tab navigator.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: mockRootNavigate }),
}));

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

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

type HeaderLeftOptions = { headerLeft?: () => React.ReactElement };

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

describe('Map header drawer nav section', () => {
  beforeEach(() => {
    resetMapMocks();
    mockRootNavigate.mockClear();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
    useDepthPreferencesStore.setState({
      enable_habits: true,
      enable_practices: true,
      enable_course: true,
    });
  });

  it('renders the nav section before the stage legend, with a trailing divider', () => {
    const tree = create(<MapScreen />);
    openDrawer();

    expect(tree.root.findByProps({ testID: 'drawer-nav-Map' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'drawer-nav-divider' })).toBeTruthy();

    const json = JSON.stringify(tree.toJSON());
    const navIndex = json.indexOf('"testID":"drawer-nav-Journal"');
    const legendIndex = json.indexOf('"testID":"map-drawer-stage-1"');
    expect(navIndex).toBeGreaterThan(-1);
    expect(legendIndex).toBeGreaterThan(-1);
    expect(navIndex).toBeLessThan(legendIndex);

    act(() => tree.unmount());
  });

  it('marks the Map nav row selected', () => {
    const tree = create(<MapScreen />);
    openDrawer();

    // findByProps returns the DrawerItem composite here, which carries the
    // `selected` prop that drives its host's accessibilityState.selected.
    const navRow = tree.root.findByProps({ testID: 'drawer-nav-Map' });
    expect(navRow.props.selected).toBe(true);

    act(() => tree.unmount());
  });

  it('tapping a non-current nav row navigates and closes the drawer', () => {
    const tree = create(<MapScreen />);
    openDrawer();

    act(() => {
      tree.root.findByProps({ testID: 'drawer-nav-Journal' }).props.onPress();
    });

    expect(mockRootNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
    expect(() => tree.root.findByProps({ testID: 'map-drawer' })).toThrow();

    act(() => tree.unmount());
  });
});
