import { describe, expect, it, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import styles from '../../Habits.styles';
import ConfirmDialog from '../ConfirmDialog';

describe('ConfirmDialog', () => {
  const defaultProps = {
    title: 'Are you sure?',
    message: 'This is permanent.',
    testID: 'confirm-dialog',
    cancelTestID: 'confirm-cancel',
    confirmTestID: 'confirm-ok',
    onCancel: jest.fn(),
    onConfirm: jest.fn(),
  };

  it('renders title and message when visible', () => {
    const { getByText } = render(<ConfirmDialog visible {...defaultProps} />);
    expect(getByText('Are you sure?')).toBeTruthy();
    expect(getByText('This is permanent.')).toBeTruthy();
  });

  it('omits the message when not provided', () => {
    const { queryByText } = render(<ConfirmDialog visible {...defaultProps} message={undefined} />);
    expect(queryByText('This is permanent.')).toBeNull();
  });

  it('uses provided labels (Cancel/Delete) instead of defaults', () => {
    const { getByText } = render(
      <ConfirmDialog visible {...defaultProps} cancelLabel="Cancel" confirmLabel="Delete" />,
    );
    expect(getByText('Cancel')).toBeTruthy();
    expect(getByText('Delete')).toBeTruthy();
  });

  it('invokes onCancel and onConfirm when buttons are pressed', () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    const { getByTestId } = render(
      <ConfirmDialog visible {...defaultProps} onCancel={onCancel} onConfirm={onConfirm} />,
    );
    fireEvent.press(getByTestId('confirm-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.press(getByTestId('confirm-ok'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('applies the destructive style to the confirm label when destructive=true', () => {
    const { getByText } = render(
      <ConfirmDialog visible {...defaultProps} destructive confirmLabel="Delete" />,
    );
    const label = getByText('Delete');
    expect(label.props.style).toEqual(styles.discardExitText);
  });

  it('uses the neutral style for the confirm label when destructive=false', () => {
    const { getByText } = render(
      <ConfirmDialog visible {...defaultProps} destructive={false} confirmLabel="OK" />,
    );
    const label = getByText('OK');
    expect(label.props.style).toEqual(styles.discardButtonText);
  });

  it('does not render its body when visible is false', () => {
    const { queryByTestId, queryByText } = render(
      <ConfirmDialog visible={false} {...defaultProps} />,
    );
    // The body is gated with `{visible && ...}` so neither the testID
    // overlay nor the title text should be in the tree.
    expect(queryByTestId('confirm-dialog')).toBeNull();
    expect(queryByText('Are you sure?')).toBeNull();
  });
});
