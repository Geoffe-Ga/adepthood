/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import ReturnCompletionCard from '../ReturnCompletionCard';
import {
  RETURN_ARC_LEAVE_A11Y,
  RETURN_COMPLETE_BODY,
  RETURN_COMPLETE_HEADING,
} from '../returnCopy';

const noop = () => undefined;

describe('ReturnCompletionCard', () => {
  it('renders the warm completion heading and body', () => {
    const { getByText } = render(<ReturnCompletionCard onLeave={noop} />);
    expect(getByText(RETURN_COMPLETE_HEADING)).toBeTruthy();
    expect(getByText(RETURN_COMPLETE_BODY)).toBeTruthy();
  });

  it('carries the completion-card testID', () => {
    const { getByTestId } = render(<ReturnCompletionCard onLeave={noop} />);
    expect(getByTestId('return-completion-card')).toBeTruthy();
  });

  it('the set-down affordance reuses the leave a11y label and calls onLeave once', () => {
    const onLeave = jest.fn();
    const { getByTestId } = render(<ReturnCompletionCard onLeave={onLeave} />);
    const leaveBtn = getByTestId('return-completion-leave');
    expect(leaveBtn.props.accessibilityLabel).toBe(RETURN_ARC_LEAVE_A11Y);
    fireEvent.press(leaveBtn);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('renders no pause or resume affordance', () => {
    const { queryByTestId } = render(<ReturnCompletionCard onLeave={noop} />);
    expect(queryByTestId('return-arc-pause')).toBeNull();
    expect(queryByTestId('return-arc-resume')).toBeNull();
  });
});
