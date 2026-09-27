/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { PROMOTE_EXPLAINER_BODY } from '../promoteExplainerCopy';
import PromoteExplainerDialog, {
  type PromoteExplainerDialogProps,
} from '../PromoteExplainerDialog';

import { touchTarget } from '@/design/tokens';

function renderDialog(overrides: Partial<PromoteExplainerDialogProps> = {}) {
  const props: PromoteExplainerDialogProps = {
    visible: true,
    dontShowAgain: false,
    onToggleDontShowAgain: jest.fn(),
    onContinue: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  return { ...render(<PromoteExplainerDialog {...props} />), props };
}

describe('PromoteExplainerDialog', () => {
  it('renders nothing while hidden', () => {
    const { queryByTestId } = renderDialog({ visible: false });
    expect(queryByTestId('promote-explainer-card')).toBeNull();
  });

  it('titles the note as a header and says where the quote goes', () => {
    const { getByRole, getByTestId } = renderDialog();
    expect(getByRole('header', { name: 'Promote a quote' })).toBeTruthy();
    expect(getByTestId('promote-explainer-body')).toHaveTextContent(PROMOTE_EXPLAINER_BODY);
  });

  it('the tick is a real checkbox whose checked state follows the prop', () => {
    const unticked = renderDialog();
    const box = unticked.getByTestId('promote-explainer-dont-show');
    expect(box.props.accessibilityRole).toBe('checkbox');
    expect(box.props.accessibilityState.checked).toBe(false);
    expect(box).toHaveTextContent('Don’t show this again', { exact: false });
    fireEvent.press(box);
    expect(unticked.props.onToggleDontShowAgain).toHaveBeenCalledTimes(1);
    unticked.unmount();

    const ticked = renderDialog({ dontShowAgain: true });
    const tickedBox = ticked.getByTestId('promote-explainer-dont-show');
    expect(tickedBox.props.accessibilityState.checked).toBe(true);
  });

  it('offers both arms at the same size, each a full touch target', () => {
    const { getByTestId } = renderDialog();
    const cancel = StyleSheet.flatten(getByTestId('promote-explainer-cancel').props.style);
    const proceed = StyleSheet.flatten(getByTestId('promote-explainer-continue').props.style);
    expect(cancel.flex).toBe(1);
    expect(proceed.flex).toBe(1);
    expect(cancel.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(proceed.minHeight).toBe(cancel.minHeight);
    expect(getByTestId('promote-explainer-continue')).toHaveTextContent('Choose the passage');
    expect(getByTestId('promote-explainer-cancel')).toHaveTextContent('Not now');
  });

  it('each arm reports itself, and the scrim declines like "Not now"', () => {
    const { getByTestId, props } = renderDialog();
    fireEvent.press(getByTestId('promote-explainer-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    fireEvent.press(getByTestId('promote-explainer-cancel'));
    fireEvent.press(getByTestId('promote-explainer-scrim'));
    expect(props.onCancel).toHaveBeenCalledTimes(2);
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });
});
