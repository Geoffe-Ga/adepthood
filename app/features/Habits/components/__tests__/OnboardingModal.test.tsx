/* eslint-disable import/order */
import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

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
});
