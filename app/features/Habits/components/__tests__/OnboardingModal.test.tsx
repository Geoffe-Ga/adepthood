/* eslint-env jest */
/* eslint-disable import/order, @typescript-eslint/consistent-type-imports, @typescript-eslint/no-explicit-any */
import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';
import { Text, TextInput, TouchableOpacity } from 'react-native';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => {
  const React = require('react');
  const { View } = require('react-native');
  return ({
    data,
    renderItem,
    onDragEnd,
    testID,
    contentContainerStyle,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: unknown[];
    renderItem: any;
    onDragEnd: any;
    testID: string;
    contentContainerStyle: unknown;
    ListHeaderComponent: React.ReactNode;
    ListFooterComponent: React.ReactNode;
  }) => (
    <View testID={testID} onDragEnd={onDragEnd} data={data} style={contentContainerStyle}>
      {ListHeaderComponent}
      {(data as unknown[]).map((item, index: number) =>
        React.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: (item as any).id },
        ),
      )}
      {ListFooterComponent}
    </View>
  );
});
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    LongPress: () => ({ minDuration: () => ({ onStart: () => ({}) }) }),
    Pan: () => ({ onBegin: () => ({}) }),
    Race: () => ({}),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  View: require('react-native').View,
}));

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
    const plus = root.findAllByType(Text).find((t: any) => t.props.children === '+');
    if (!plus) throw new Error('Plus button not found');
    let plusParent: any = plus.parent;
    while (plusParent && plusParent.type !== TouchableOpacity) {
      plusParent = plusParent.parent;
    }
    if (!plusParent) throw new Error('Plus button not found');
    renderer.act(() => {
      plusParent.props.onPress();
    });

    const pressContinue = () => {
      const button = root.findByProps({ testID: 'continue-button' });
      renderer.act(() => {
        button.props.onPress();
      });
      const modalContinue = root.findAllByProps({ testID: 'count-warning-continue' });
      if (modalContinue.length > 0) {
        renderer.act(() => {
          modalContinue[0].props.onPress();
        });
      }
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
    const onSave = jest.fn((_: { start_date: Date }[]) => undefined);
    const tree = renderer.create(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={onSave} />,
    );
    const root = tree.root;

    const input = root.findByType(TextInput);
    renderer.act(() => {
      input.props.onChangeText('Test');
    });
    // add habit via plus button
    const plus = root.findAllByType(Text).find((t: any) => t.props.children === '+');
    let plusParent: any = plus.parent;
    while (plusParent && plusParent.type !== TouchableOpacity) {
      plusParent = plusParent.parent;
    }
    renderer.act(() => {
      plusParent.props.onPress();
    });

    const pressContinue = () => {
      const button = root.findByProps({ testID: 'continue-button' });
      renderer.act(() => {
        button.props.onPress();
      });
      const modalContinue = root.findAllByProps({ testID: 'count-warning-continue' });
      if (modalContinue.length > 0) {
        renderer.act(() => {
          modalContinue[0].props.onPress();
        });
      }
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

    const saved = (onSave.mock.calls[0]?.[0] as { start_date: Date }[] | undefined)?.[0];
    expect(saved).toBeDefined();
    expect(saved!.start_date.getFullYear()).toBe(2025);
    expect(saved!.start_date.getMonth()).toBe(8);
    expect(saved!.start_date.getDate()).toBe(10);
    process.env.TZ = originalTZ;
  });
});
