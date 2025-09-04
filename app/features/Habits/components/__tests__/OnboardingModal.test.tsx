/* eslint-disable import/order */
import { describe, expect, it, jest } from '@jest/globals';
import type React from 'react';
import renderer from 'react-test-renderer';
import { Text, TextInput, TouchableOpacity } from 'react-native';

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => {
  const React = require('react');
  const { View } = require('react-native');
  const mockGesture = {
    minDuration: () => mockGesture,
    onStart: () => mockGesture,
    activateAfterLongPress: () => mockGesture,
    onBegin: () => mockGesture,
  };
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    Gesture: {
      LongPress: () => mockGesture,
      Pan: () => mockGesture,
      Race: () => mockGesture,
    },
  };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const Animated = { View };
  return { __esModule: true, default: Animated, View };
});

const OnboardingModal = require('../OnboardingModal').default;

describe('OnboardingModal close behaviour', () => {
  it('shows discard dialog and exits on confirmation', () => {
    const onClose = jest.fn();

    const tree = renderer.create(
      <OnboardingModal visible onClose={onClose} onSaveHabits={jest.fn()} />,
    );

    const close = tree.root.findByProps({ testID: 'onboarding-close' });
    renderer.act(() => {
      close.props.onPress();
    });

    const dialog = tree.root.findByProps({ testID: 'discard-confirm' });
    const exit = dialog.findByProps({ testID: 'discard-exit' });
    renderer.act(() => {
      exit.props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('cancels discard and keeps modal open', () => {
    const onClose = jest.fn();

    const tree = renderer.create(
      <OnboardingModal visible onClose={onClose} onSaveHabits={jest.fn()} />,
    );

    const close = tree.root.findByProps({ testID: 'onboarding-close' });
    renderer.act(() => {
      close.props.onPress();
    });

    const dialog = tree.root.findByProps({ testID: 'discard-confirm' });
    const cancel = dialog.findByProps({ testID: 'discard-cancel' });
    renderer.act(() => {
      cancel.props.onPress();
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows date picker and saves habits on finish', () => {
    const onClose = jest.fn();
    const onSave = jest.fn();
    const tree = renderer.create(
      <OnboardingModal visible onClose={onClose} onSaveHabits={onSave} />,
    );
    const root = tree.root;

    // Step 1: add a habit and continue through steps
    const input = root.findByType(TextInput);
    renderer.act(() => {
      input.props.onChangeText('Test');
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plus = root.findAllByType(Text).find((t: any) => t.props.children === '+');
    if (!plus) throw new Error('Plus button not found');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let plusParent: any = plus.parent;
    while (plusParent && plusParent.type !== TouchableOpacity) {
      plusParent = plusParent.parent;
    }
    if (!plusParent) throw new Error('Plus button not found');
    renderer.act(() => {
      plusParent.props.onPress();
    });

    const pressContinue = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = root.findAllByType(Text).find((t: any) => t.props.children === 'Continue');
      if (!text) throw new Error('Continue button not found');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parent: any = text.parent;
      while (parent && parent.type !== TouchableOpacity) {
        parent = parent.parent;
      }
      if (!parent) throw new Error('Continue button not found');
      renderer.act(() => {
        parent.props.onPress();
      });
    };
    pressContinue(); // to cost step
    pressContinue(); // to return step
    pressContinue(); // to reorder step

    const dateInput = root.findByProps({ accessibilityLabel: 'Date' });
    renderer.act(() => {
      dateInput.props.onChangeText('2025-09-10');
    });

    const finish = root.findByProps({ testID: 'finish-setup' });
    renderer.act(() => {
      finish.props.onPress();
    });
    expect(onSave).toHaveBeenCalled();
  });

  it('uses selected start date for first habit', () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    // eslint-disable-next-line no-unused-vars
    const onSave = jest.fn<(_: { start_date: Date }[]) => void>();
    const tree = renderer.create(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={onSave} />,
    );
    const root = tree.root;

    const input = root.findByType(TextInput);
    renderer.act(() => {
      input.props.onChangeText('Test');
    });
    // add habit via plus button
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plus = root.findAllByType(Text).find((t: any) => t.props.children === '+');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let plusParent: any = plus.parent;
    while (plusParent && plusParent.type !== TouchableOpacity) {
      plusParent = plusParent.parent;
    }
    renderer.act(() => {
      plusParent.props.onPress();
    });

    const pressContinue = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = root.findAllByType(Text).find((t: any) => t.props.children === 'Continue');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parent: any = text.parent;
      while (parent && parent.type !== TouchableOpacity) {
        parent = parent.parent;
      }
      renderer.act(() => {
        parent.props.onPress();
      });
    };
    pressContinue();
    pressContinue();
    pressContinue();

    const dateInput = root.findByProps({ accessibilityLabel: 'Date' });
    renderer.act(() => {
      dateInput.props.onChangeText('2025-09-10');
    });

    const finish = root.findByProps({ testID: 'finish-setup' });
    renderer.act(() => {
      finish.props.onPress();
    });

    const saved = onSave.mock.calls[0]?.[0]?.[0];
    expect(saved).toBeDefined();
    expect(saved!.start_date.getFullYear()).toBe(2025);
    expect(saved!.start_date.getMonth()).toBe(8);
    expect(saved!.start_date.getDate()).toBe(10);
    process.env.TZ = originalTZ;
  });
});
