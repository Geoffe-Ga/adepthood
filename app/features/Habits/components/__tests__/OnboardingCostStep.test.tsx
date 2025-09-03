import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../HabitsScreen', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

describe('OnboardingModal cost step', () => {
  const setup = () => {
    const utils = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    const input = utils.getByPlaceholderText('Enter habit name');
    fireEvent.changeText(input, 'Habit 1');
    fireEvent.press(utils.getByText('+'));
    fireEvent.changeText(input, 'Habit 2');
    fireEvent.press(utils.getByText('+'));
    fireEvent.press(utils.getByText('Continue'));
    return utils;
  };

  it('defaults each cost to 5', () => {
    const utils = setup();
    const selectors = utils.getAllByTestId(/cost-selector-/);
    expect(selectors).toHaveLength(2);
    selectors.forEach((s) => {
      expect(s.props.value).toBe(5);
    });
  });

  it('renders compact habit tiles', () => {
    const utils = setup();
    const tile = utils.getByTestId('cost-tile-0');
    expect(StyleSheet.flatten(tile.props.style)).toMatchSnapshot();
  });
});
