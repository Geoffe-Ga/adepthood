import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import React from 'react';

import AddHabitModal from '../AddHabitModal';

jest.mock('../../constants', () => ({ DEFAULT_ICONS: ['⭐'] }));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('AddHabitModal', () => {
  const noopAdd = () => Promise.resolve();

  it('disables the save button while the name is empty', () => {
    const { getByTestId } = render(<AddHabitModal visible onClose={jest.fn()} onAdd={noopAdd} />);
    const save = getByTestId('add-habit-save');
    expect(save.props.accessibilityState?.disabled ?? save.props.disabled).toBe(true);
  });

  it('enables save once a name is typed and emits a trimmed payload', async () => {
    const onAdd = jest.fn(() => Promise.resolve());
    const onClose = jest.fn();
    const { getByTestId } = render(<AddHabitModal visible onClose={onClose} onAdd={onAdd} />);
    fireEvent.changeText(getByTestId('add-habit-name'), '  Morning Walk  ');
    fireEvent.changeText(getByTestId('add-habit-cost'), '3');
    fireEvent.changeText(getByTestId('add-habit-return'), '7');
    await act(async () => {
      fireEvent.press(getByTestId('add-habit-save'));
      await flushPromises();
    });
    expect(onAdd).toHaveBeenCalledWith({
      name: 'Morning Walk',
      icon: '⭐',
      energy_cost: 3,
      energy_return: 7,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects out-of-range energy inputs and keeps the previous value', () => {
    const { getByTestId } = render(<AddHabitModal visible onClose={jest.fn()} onAdd={noopAdd} />);
    const cost = getByTestId('add-habit-cost');
    fireEvent.changeText(cost, '5');
    expect(cost.props.value).toBe('5');
    fireEvent.changeText(cost, '99');
    expect(cost.props.value).toBe('5');
    fireEvent.changeText(cost, '-3');
    expect(cost.props.value).toBe('-3');
    fireEvent.changeText(cost, '-99');
    expect(cost.props.value).toBe('-3');
  });

  it('closes the modal even when onAdd rejects', async () => {
    const onAdd = jest.fn(() => Promise.reject(new Error('boom')));
    const onClose = jest.fn();
    const { getByTestId } = render(<AddHabitModal visible onClose={onClose} onAdd={onAdd} />);
    fireEvent.changeText(getByTestId('add-habit-name'), 'Read');
    await act(async () => {
      fireEvent.press(getByTestId('add-habit-save'));
      await flushPromises();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets the form when the modal is reopened', () => {
    const onAdd = jest.fn(() => Promise.resolve());
    const { getByTestId, rerender } = render(
      <AddHabitModal visible onClose={jest.fn()} onAdd={onAdd} />,
    );
    fireEvent.changeText(getByTestId('add-habit-name'), 'Read');
    expect(getByTestId('add-habit-name').props.value).toBe('Read');
    rerender(<AddHabitModal visible={false} onClose={jest.fn()} onAdd={onAdd} />);
    rerender(<AddHabitModal visible onClose={jest.fn()} onAdd={onAdd} />);
    expect(getByTestId('add-habit-name').props.value).toBe('');
  });
});
