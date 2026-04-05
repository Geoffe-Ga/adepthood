/* eslint-env jest */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('react-native-draggable-flatlist', () => {
  const { View } = require('react-native');
  return ({
    data,
    renderItem,
  }: {
    data: Array<{ name: string }>;
    renderItem: (info: { item: { name: string }; drag: () => void }) => React.ReactNode;
  }) => (
    <View testID="draggable-list">
      {data.map((item: { name: string }) => (
        <View key={item.name}>{renderItem({ item, drag: () => {} })}</View>
      ))}
    </View>
  );
});
jest.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => ({ onUpdate: jest.fn(), onEnd: jest.fn() }) },
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: 'Animated.View',
    createAnimatedComponent: (c: unknown) => c,
  },
  useSharedValue: () => ({ value: 0 }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
}));
jest.mock('../../../api', () => ({
  goalGroups: { list: jest.fn(() => Promise.resolve([])) },
}));
jest.mock('@react-native-community/slider', () => {
  const { View } = require('react-native');
  return (props: { testID?: string; onValueChange?: (v: number) => void; value?: number }) => (
    <View testID={props.testID} {...props} />
  );
});
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

import { OnboardingModal } from '../components/OnboardingModal';

describe('OnboardingModal flow', () => {
  const mockClose = jest.fn();
  const mockSave = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adds habits in step 1 and shows them as chips', () => {
    const component = renderer.create(
      <OnboardingModal visible onClose={mockClose} onSaveHabits={mockSave} />,
    );

    // Step 1: Type and add two habits
    const input = component.root.findByProps({ testID: 'habit-input' });

    renderer.act(() => {
      input.props.onChangeText('Running');
    });
    const addButton = component.root.findByProps({ testID: 'add-habit-button' });
    renderer.act(() => {
      addButton.props.onPress();
    });

    renderer.act(() => {
      input.props.onChangeText('Meditation');
    });
    // Re-find the add button since the tree may have updated
    const addButton2 = component.root.findByProps({ testID: 'add-habit-button' });
    renderer.act(() => {
      addButton2.props.onPress();
    });

    // Habit count should read "2 / 10" — confirms both habits were added
    const count = component.root.findByProps({ testID: 'habit-count' });
    expect(count.props.children).toBe('2 / 10');
  });

  it('pressing continue with <10 habits shows count warning', () => {
    const component = renderer.create(
      <OnboardingModal visible onClose={mockClose} onSaveHabits={mockSave} />,
    );

    // Add one habit
    const input = component.root.findByProps({ testID: 'habit-input' });
    renderer.act(() => {
      input.props.onChangeText('Running');
    });
    const addButton = component.root.findByProps({ testID: 'add-habit-button' });
    renderer.act(() => {
      addButton.props.onPress();
    });

    // Press continue
    const continueBtn = component.root.findByProps({ testID: 'continue-button' });
    renderer.act(() => {
      continueBtn.props.onPress();
    });

    // Count warning modal should appear
    const warningModal = component.root.findByProps({ testID: 'count-warning-modal' });
    expect(warningModal).toBeTruthy();
  });

  it('confirming count warning advances to step 2', () => {
    const component = renderer.create(
      <OnboardingModal visible onClose={mockClose} onSaveHabits={mockSave} />,
    );

    // Add one habit
    const input = component.root.findByProps({ testID: 'habit-input' });
    renderer.act(() => {
      input.props.onChangeText('Running');
    });
    const addButton = component.root.findByProps({ testID: 'add-habit-button' });
    renderer.act(() => {
      addButton.props.onPress();
    });

    // Press continue -> triggers warning
    const continueBtn = component.root.findByProps({ testID: 'continue-button' });
    renderer.act(() => {
      continueBtn.props.onPress();
    });

    // Confirm the warning to advance to step 2
    const confirmBtn = component.root.findByProps({ testID: 'count-warning-continue' });
    renderer.act(() => {
      confirmBtn.props.onPress();
    });

    // Step 2 should show energy cost sliders
    const costSliders = component.root.findAllByProps({ testID: 'cost-slider' });
    expect(costSliders.length).toBeGreaterThan(0);
  });

  it('does not add empty habit names (button is disabled)', () => {
    const component = renderer.create(
      <OnboardingModal visible onClose={mockClose} onSaveHabits={mockSave} />,
    );

    // The add button should be disabled when input is empty
    const addButton = component.root.findByProps({ testID: 'add-habit-button' });
    expect(addButton.props.disabled).toBe(true);

    // No chips should exist
    const chips = component.root.findAllByProps({ testID: 'habit-chip' });
    expect(chips).toHaveLength(0);
  });
});
