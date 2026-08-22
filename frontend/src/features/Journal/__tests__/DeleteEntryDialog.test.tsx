/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import DeleteEntryDialog from '../DeleteEntryDialog';

function renderDialog(visible = true) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <DeleteEntryDialog visible={visible} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  return { ...utils, onConfirm, onCancel };
}

describe('DeleteEntryDialog', () => {
  it('names both choices for a reader who cannot see them', () => {
    const { getByTestId } = renderDialog();

    expect(getByTestId('journal-delete-confirm').props.accessibilityLabel).toBe('Delete this page');
    expect(getByTestId('journal-delete-cancel').props.accessibilityLabel).toBe('Keep this page');
  });

  it('treats a tap outside the card as keeping the page', () => {
    const { getByTestId, onCancel, onConfirm } = renderDialog();

    fireEvent.press(getByTestId('journal-delete-scrim'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('asks nothing while it is closed', () => {
    const { queryByTestId } = renderDialog(false);

    expect(queryByTestId('journal-delete-dialog-body')).toBeNull();
  });
});
