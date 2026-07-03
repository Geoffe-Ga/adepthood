/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Pins the MapScreen JourneyHeader trigger contract: a TouchableOpacity with
// testID="wavelength-explainer-trigger", accessibilityRole="button", and an
// accessibilityLabel like "How the Wavelength works" that opens
// WavelengthExplainer. The explainer must never be visible on initial render.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

import { mockMapState, resetMapMocks } from './mapTestHarness';

// Mock ChapterReader so the explainer's live content fetch never runs in this
// MapScreen wiring test; its back control (testID="reader-back-button") is the
// explainer's close affordance.
jest.mock('../../Course/ChapterReader', () => {
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ fallbackTitle, onBack }: { fallbackTitle: string; onBack: () => void }) => (
      <Pressable testID="reader-back-button" onPress={onBack}>
        <Text>{fallbackTitle}</Text>
      </Pressable>
    ),
  };
});

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

describe('MapScreen wavelength explainer trigger', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.derivedStage = 1;
    mockMapState.derivedWeek = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('does not show the explainer on initial render', () => {
    const tree = create(<MapScreen />);
    expect(
      tree.root.findAll((n: TestNode) => n.props.testID === 'wavelength-explainer'),
    ).toHaveLength(0);
  });

  it('renders the trigger in the journey header with an accessible label', () => {
    const tree = create(<MapScreen />);
    const trigger = tree.root.findByProps({ testID: 'wavelength-explainer-trigger' });
    expect(trigger.props.accessibilityRole).toBe('button');
    expect(trigger.props.accessibilityLabel).toMatch(/wavelength/i);
  });

  it('opens the explainer when the trigger is pressed', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'wavelength-explainer-trigger' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'wavelength-explainer' })).toBeTruthy();
  });

  it('dismisses the explainer when the close affordance is pressed', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'wavelength-explainer-trigger' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'reader-back-button' }).props.onPress();
    });
    expect(
      tree.root.findAll((n: TestNode) => n.props.testID === 'wavelength-explainer'),
    ).toHaveLength(0);
  });
});
