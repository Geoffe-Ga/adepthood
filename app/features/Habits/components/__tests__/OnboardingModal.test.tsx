/* eslint-disable import/order */
import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Alert } from 'react-native';
import renderer from 'react-test-renderer';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

describe('OnboardingModal close behaviour', () => {
  it('confirms before exiting via close button', () => {
    const onClose = jest.fn();
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.[1]?.onPress?.();
    });

    const tree = renderer.create(
      <OnboardingModal visible onClose={onClose} onSaveHabits={jest.fn()} />,
    );

    const close = tree.root.findByProps({ testID: 'onboarding-close' });
    renderer.act(() => {
      close.props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('confirms before exiting via backdrop', () => {
    const onClose = jest.fn();
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.[1]?.onPress?.();
    });

    const tree = renderer.create(
      <OnboardingModal visible onClose={onClose} onSaveHabits={jest.fn()} />,
    );

    const overlay = tree.root.findByProps({ testID: 'onboarding-overlay' });
    renderer.act(() => {
      overlay.props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
  });
});
