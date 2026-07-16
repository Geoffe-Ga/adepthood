/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import CopyToStageDialog, { copyDialogText } from '../CopyToStageDialog';

const baseProps = {
  visible: true,
  practiceName: 'Forest grounding',
  homeStage: 2,
  targetStage: 4,
  busy: false,
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
};

describe('copyDialogText', () => {
  it('names the practice in the title', () => {
    const text = copyDialogText('Forest grounding', 2, 4);
    expect(text.title).toContain('Forest grounding');
  });

  it('names both the home and target stage in the message', () => {
    const text = copyDialogText('Forest grounding', 2, 4);
    expect(text.message).toContain('Purple');
    expect(text.message).toContain('Blue');
  });

  it('supplies non-empty confirm and cancel labels', () => {
    const text = copyDialogText('Forest grounding', 2, 4);
    expect(text.confirmLabel.length).toBeGreaterThan(0);
    expect(text.cancelLabel.length).toBeGreaterThan(0);
  });
});

describe('CopyToStageDialog', () => {
  it('renders the dialog body with the practice name and both stage names when visible', () => {
    const { getByTestId, getByText } = render(<CopyToStageDialog {...baseProps} />);
    expect(getByTestId('practice-copy-dialog')).toBeTruthy();
    expect(getByText(/Forest grounding/)).toBeTruthy();
    expect(getByText(/Purple/)).toBeTruthy();
    expect(getByText(/Blue/)).toBeTruthy();
  });

  it('renders nothing when not visible', () => {
    const { queryByTestId } = render(<CopyToStageDialog {...baseProps} visible={false} />);
    expect(queryByTestId('practice-copy-dialog')).toBeNull();
  });

  it('fires onConfirm exactly once when the confirm control is pressed', () => {
    const onConfirm = jest.fn();
    const { getByTestId } = render(<CopyToStageDialog {...baseProps} onConfirm={onConfirm} />);
    fireEvent.press(getByTestId('practice-copy-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel exactly once when the cancel control is pressed', () => {
    const onCancel = jest.fn();
    const { getByTestId } = render(<CopyToStageDialog {...baseProps} onCancel={onCancel} />);
    fireEvent.press(getByTestId('practice-copy-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not fire onConfirm when busy', () => {
    const onConfirm = jest.fn();
    const { getByTestId } = render(<CopyToStageDialog {...baseProps} busy onConfirm={onConfirm} />);
    fireEvent.press(getByTestId('practice-copy-dialog-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('CopyToStageDialog — editable name', () => {
  it('prefills the name field verbatim with practiceName and autofocuses it', () => {
    const { getByTestId } = render(<CopyToStageDialog {...baseProps} />);
    const nameInput = getByTestId('practice-copy-dialog-name');
    expect(nameInput.props.value).toBe('Forest grounding');
    expect(nameInput.props.autoFocus).toBe(true);
  });

  it('passes the edited name to onConfirm when the confirm control is pressed', () => {
    const onConfirm = jest.fn();
    const { getByTestId } = render(<CopyToStageDialog {...baseProps} onConfirm={onConfirm} />);
    fireEvent.changeText(getByTestId('practice-copy-dialog-name'), 'Woodland grounding');
    fireEvent.press(getByTestId('practice-copy-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('Woodland grounding');
  });

  it('passes the unedited practiceName to onConfirm when the name is left as-is', () => {
    const onConfirm = jest.fn();
    const { getByTestId } = render(<CopyToStageDialog {...baseProps} onConfirm={onConfirm} />);
    fireEvent.press(getByTestId('practice-copy-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('Forest grounding');
  });

  it('disables confirm and shows "Name is required." when the name is trimmed empty', () => {
    const { getByTestId, getByText } = render(<CopyToStageDialog {...baseProps} />);
    fireEvent.changeText(getByTestId('practice-copy-dialog-name'), '   ');
    expect(getByTestId('practice-copy-dialog-confirm').props.accessibilityState?.disabled).toBe(
      true,
    );
    expect(getByText(/Name is required\./)).toBeTruthy();
  });

  it('reseeds the name field from practiceName each time the dialog reopens with a different name', () => {
    const { getByTestId, rerender } = render(<CopyToStageDialog {...baseProps} />);
    fireEvent.changeText(getByTestId('practice-copy-dialog-name'), 'Edited once');
    rerender(<CopyToStageDialog {...baseProps} visible={false} />);
    rerender(<CopyToStageDialog {...baseProps} visible practiceName="Steady breath" />);
    expect(getByTestId('practice-copy-dialog-name').props.value).toBe('Steady breath');
  });
});
