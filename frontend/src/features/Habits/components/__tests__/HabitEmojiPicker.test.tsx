/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import HabitEmojiPicker from '../HabitEmojiPicker';

describe('HabitEmojiPicker', () => {
  it('renders nothing when not visible', () => {
    const { queryByTestId } = render(
      <HabitEmojiPicker visible={false} onSelect={() => {}} onClose={() => {}} />,
    );

    expect(queryByTestId('emoji-picker')).toBeNull();
  });

  it('renders the picker when visible', () => {
    const { getByTestId } = render(
      <HabitEmojiPicker visible onSelect={() => {}} onClose={() => {}} />,
    );

    expect(getByTestId('emoji-picker')).toBeTruthy();
  });

  it('forwards the selected emoji string to onSelect', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <HabitEmojiPicker visible onSelect={onSelect} onClose={() => {}} />,
    );

    fireEvent.press(getByTestId('emoji-picker-select'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('\u{1F389}');
  });

  it('calls onClose when the picker is dismissed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <HabitEmojiPicker visible onSelect={() => {}} onClose={onClose} />,
    );

    fireEvent.press(getByTestId('emoji-picker-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
