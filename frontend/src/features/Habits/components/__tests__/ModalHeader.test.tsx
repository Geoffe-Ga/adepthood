import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';

import ModalHeader from '../ModalHeader';

describe('ModalHeader', () => {
  it('renders a plain string title and the close glyph', () => {
    const { getByText } = render(<ModalHeader title="Add Habit" onClose={jest.fn()} />);
    expect(getByText('Add Habit')).toBeTruthy();
    expect(getByText('×')).toBeTruthy();
  });

  it('calls onClose exactly once when the close button is pressed', () => {
    const onClose = jest.fn();
    const { getByText } = render(<ModalHeader title="Add Habit" onClose={onClose} />);
    fireEvent.press(getByText('×'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('carries a testID on the close button when provided, and omits it otherwise', () => {
    const { getByTestId } = render(
      <ModalHeader title="Add Habit" onClose={jest.fn()} closeTestID="modal-header-close" />,
    );
    expect(getByTestId('modal-header-close')).toBeTruthy();

    const { queryByTestId } = render(<ModalHeader title="Add Habit" onClose={jest.fn()} />);
    expect(queryByTestId('modal-header-close')).toBeNull();
  });

  it('renders a compound ReactNode title with a nested Text part', () => {
    const { getByText } = render(
      <ModalHeader
        title={
          <>
            Morning Walk Stats <Text>ICON</Text>
          </>
        }
        onClose={jest.fn()}
      />,
    );
    expect(getByText('ICON')).toBeTruthy();
    expect(getByText('Morning Walk Stats ICON')).toBeTruthy();
  });

  it('renders children between the title and the close button', () => {
    const onExtraPress = jest.fn();
    const { getByTestId } = render(
      <ModalHeader title="Add Habit" onClose={jest.fn()}>
        <TouchableOpacity testID="extra-control" onPress={onExtraPress}>
          <Text>slot</Text>
        </TouchableOpacity>
      </ModalHeader>,
    );
    const extra = getByTestId('extra-control');
    expect(extra).toBeTruthy();
    fireEvent.press(extra);
    expect(onExtraPress).toHaveBeenCalledTimes(1);
  });
});
