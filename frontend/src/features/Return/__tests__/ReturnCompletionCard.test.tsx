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

import type { ReleasedHabit } from '@/api';

const noop = () => undefined;

function releasedHabit(overrides: Partial<ReleasedHabit> = {}): ReleasedHabit {
  return { habit_id: 1, name: 'Morning pages', icon: '📓', recommitted: false, ...overrides };
}

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

describe('ReturnCompletionCard — re-commit', () => {
  const releasedFixture: ReleasedHabit[] = [
    releasedHabit({ habit_id: 1, name: 'Morning pages', recommitted: false }),
    releasedHabit({ habit_id: 2, name: 'Evening walk', recommitted: true }),
  ];

  it('lists only the released, not-yet-recommitted habits with a Take it up again action', () => {
    const { getByTestId, queryByTestId } = render(
      <ReturnCompletionCard onLeave={noop} releasedHabits={releasedFixture} onRecommit={noop} />,
    );
    expect(getByTestId('return-recommit-1')).toBeTruthy();
    expect(queryByTestId('return-recommit-2')).toBeNull();
  });

  it('pressing a habit Take it up again action recommits only that habit', () => {
    const onRecommit = jest.fn();
    const { getByTestId } = render(
      <ReturnCompletionCard
        onLeave={noop}
        releasedHabits={releasedFixture}
        onRecommit={onRecommit}
      />,
    );
    fireEvent.press(getByTestId('return-recommit-1'));
    expect(onRecommit).toHaveBeenCalledTimes(1);
    expect(onRecommit).toHaveBeenCalledWith(1);
  });

  it('renders no re-commit section when there are no released habits', () => {
    const { queryByTestId } = render(
      <ReturnCompletionCard onLeave={noop} releasedHabits={[]} onRecommit={noop} />,
    );
    expect(queryByTestId('return-recommit-section')).toBeNull();
    expect(queryByTestId('return-recommit-1')).toBeNull();
  });

  it('still calls onLeave once from the set-down affordance alongside a re-commit section', () => {
    const onLeave = jest.fn();
    const { getByTestId } = render(
      <ReturnCompletionCard onLeave={onLeave} releasedHabits={releasedFixture} onRecommit={noop} />,
    );
    fireEvent.press(getByTestId('return-completion-leave'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
