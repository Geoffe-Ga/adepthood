/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import EditConfirmDialog from '../EditConfirmDialog';

function renderDialog(overrides: Record<string, unknown> = {}) {
  const props = {
    visible: true,
    onEdit: jest.fn(),
    onStartNew: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  return { ...render(<EditConfirmDialog {...props} />), props };
}

describe('EditConfirmDialog', () => {
  it('shows the three choices with warm copy', () => {
    const { getByTestId, getByText } = renderDialog();
    expect(getByText('Edit finished entry?')).toBeTruthy();
    expect(getByTestId('edit-confirm-edit')).toBeTruthy();
    expect(getByTestId('edit-confirm-start-new')).toBeTruthy();
    expect(getByTestId('edit-confirm-cancel')).toBeTruthy();
  });

  it('fires the matching callback for each choice', () => {
    const { getByTestId, props } = renderDialog();
    fireEvent.press(getByTestId('edit-confirm-edit'));
    fireEvent.press(getByTestId('edit-confirm-start-new'));
    fireEvent.press(getByTestId('edit-confirm-cancel'));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onStartNew).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels when the scrim is tapped', () => {
    const { getByTestId, props } = renderDialog();
    fireEvent.press(getByTestId('edit-confirm-scrim'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel when the dialog card itself is tapped', () => {
    // The card stops the tap from bubbling to the scrim, so pressing the body
    // must never dismiss the dialog.
    const { getByTestId, props } = renderDialog();
    fireEvent.press(getByTestId('edit-confirm-dialog'));
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
