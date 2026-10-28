import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { decorativeHidden } from '../../../../components/a11yHidden';
import { touchTarget } from '../../../../design/tokens';
import { MODAL_CLOSE_LABEL } from '../modalCloseLabels';
import ModalHeader from '../ModalHeader';

describe('ModalHeader', () => {
  it('renders a plain string title and the close control', () => {
    const { getByText, getByRole } = render(<ModalHeader title="Add Habit" onClose={jest.fn()} />);
    expect(getByText('Add Habit')).toBeTruthy();
    expect(getByRole('button', { name: MODAL_CLOSE_LABEL })).toBeTruthy();
  });

  it('calls onClose exactly once when the close button is pressed', () => {
    const onClose = jest.fn();
    const { getByRole } = render(<ModalHeader title="Add Habit" onClose={onClose} />);
    fireEvent.press(getByRole('button', { name: MODAL_CLOSE_LABEL }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes the close control as a named button with a 44dp target and a hidden glyph', () => {
    const onClose = jest.fn();
    const { getByRole, queryByRole, getByText } = render(
      <ModalHeader title="Add Habit" onClose={onClose} closeLabel="Close add habit" />,
    );
    const button = getByRole('button', { name: 'Close add habit' });
    fireEvent.press(button);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The caller's label is used verbatim, never alongside the default.
    expect(queryByRole('button', { name: MODAL_CLOSE_LABEL })).toBeNull();

    const style = StyleSheet.flatten(button.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);

    // The glyph is decoration: the button's name is what a reader announces.
    expect(getByText('×', { includeHiddenElements: true }).props).toMatchObject(decorativeHidden());
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
