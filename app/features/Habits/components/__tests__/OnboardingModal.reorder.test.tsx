/* eslint-disable import/order */
import { describe, expect, it, jest } from '@jest/globals';
import renderer from 'react-test-renderer';
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';

import { STAGE_COLORS } from '../../../../constants/stageColors';
import { STAGE_ORDER } from '../../HabitUtils';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return { GestureHandlerRootView: View };
});

// Provide a basic draggable list mock that renders items via FlatList
jest.mock('react-native-draggable-flatlist', () => {
  const { FlatList } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ({ data, renderItem, onDragEnd, ...rest }: any) => (
    <FlatList
      {...rest}
      data={data}
      renderItem={(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        info: any,
      ) =>
        renderItem({
          ...info,
          drag: jest.fn(),
          isActive: false,
          getIndex: () => info.index,
        })
      }
      onDragEnd={onDragEnd}
    />
  );
});

describe('OnboardingModal reorder stage colours', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addHabit = (root: any, name: string) => {
    const input = root.findByType(TextInput);
    renderer.act(() => {
      input.props.onChangeText(name);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plus = root.findAllByType(Text).find((t: any) => t.props.children === '+');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let plusParent: any = plus?.parent;
    while (plusParent && plusParent.type !== TouchableOpacity) {
      plusParent = plusParent.parent;
    }
    renderer.act(() => {
      plusParent.props.onPress();
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const advance = (root: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = root.findAllByType(Text).find((t: any) => t.props.children === 'Continue');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parent: any = text?.parent;
    while (parent && parent.type !== TouchableOpacity) {
      parent = parent.parent;
    }
    renderer.act(() => {
      parent.props.onPress();
    });
  };

  it('applies stage colours based on order and updates after drag', () => {
    const tree = renderer.create(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const root = tree.root;

    addHabit(root, 'A');
    addHabit(root, 'B');

    advance(root); // cost
    advance(root); // return
    advance(root); // reorder

    const item0 = root.findByProps({ testID: 'reorder-item-0' });
    const item1 = root.findByProps({ testID: 'reorder-item-1' });
    const style0 = StyleSheet.flatten(item0.props.style);
    const style1 = StyleSheet.flatten(item1.props.style);
    expect(style0.borderLeftColor).toBe(STAGE_COLORS[STAGE_ORDER[0] as keyof typeof STAGE_COLORS]);
    expect(style1.borderLeftColor).toBe(STAGE_COLORS[STAGE_ORDER[1] as keyof typeof STAGE_COLORS]);

    const list = root.findByType(FlatList);
    const swapped = [list.props.data[1], list.props.data[0]];
    renderer.act(() => {
      list.props.onDragEnd({ data: swapped });
    });

    const newItem0 = root.findByProps({ testID: 'reorder-item-0' });
    const newItem1 = root.findByProps({ testID: 'reorder-item-1' });
    const newStyle0 = StyleSheet.flatten(newItem0.props.style);
    const newStyle1 = StyleSheet.flatten(newItem1.props.style);
    expect(newStyle0.borderLeftColor).toBe(
      STAGE_COLORS[STAGE_ORDER[0] as keyof typeof STAGE_COLORS],
    );
    expect(newStyle1.borderLeftColor).toBe(
      STAGE_COLORS[STAGE_ORDER[1] as keyof typeof STAGE_COLORS],
    );
  });

  it('constrains modal height to avoid overflow', () => {
    const tree = renderer.create(
      <OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />,
    );
    const root = tree.root;
    const content = root.findByProps({ testID: 'onboarding-modal-content' });
    const flattened = StyleSheet.flatten(content.props.style);
    expect(flattened.maxHeight).toBe('90%');
    expect(flattened.overflow).toBe('hidden');
  });
});
