/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { RETURN_RESTING_BODY, RETURN_RESTING_HEADING } from '../returnCopy';
import ReturnRestingCard from '../ReturnRestingCard';

import type { ReleasedHabit } from '@/api';

const makeHabit = (habitId: number, name: string, recommitted = false): ReleasedHabit => ({
  habit_id: habitId,
  name,
  icon: '🕯️',
  recommitted,
});

describe('ReturnRestingCard', () => {
  it('names every habit still resting from a Return already left', () => {
    const { getByTestId, getByText } = render(
      <ReturnRestingCard
        restingHabits={[makeHabit(1, 'Morning pages'), makeHabit(2, 'Evening sit')]}
        onRecommit={jest.fn()}
      />,
    );
    expect(getByTestId('return-resting-card')).toBeTruthy();
    expect(getByText(RETURN_RESTING_HEADING)).toBeTruthy();
    expect(getByText(RETURN_RESTING_BODY)).toBeTruthy();
    expect(getByTestId('return-recommit-1')).toBeTruthy();
    expect(getByTestId('return-recommit-2')).toBeTruthy();
  });

  it('hands the habit id back when its take-it-up-again row is pressed', () => {
    const onRecommit = jest.fn();
    const { getByTestId } = render(
      <ReturnRestingCard restingHabits={[makeHabit(4, 'Morning pages')]} onRecommit={onRecommit} />,
    );
    fireEvent.press(getByTestId('return-recommit-4'));
    expect(onRecommit).toHaveBeenCalledWith(4);
  });

  it('does not render its own header twice — the card owns the heading, not the list', () => {
    const { queryAllByText } = render(
      <ReturnRestingCard restingHabits={[makeHabit(1, 'Morning pages')]} onRecommit={jest.fn()} />,
    );
    expect(queryAllByText(RETURN_RESTING_HEADING)).toHaveLength(1);
  });

  it('offers no rows for a habit that has already been taken up again', () => {
    const { queryByTestId, getByTestId } = render(
      <ReturnRestingCard
        restingHabits={[makeHabit(1, 'Morning pages', true)]}
        onRecommit={jest.fn()}
      />,
    );
    expect(getByTestId('return-resting-card')).toBeTruthy();
    expect(queryByTestId('return-recommit-1')).toBeNull();
    expect(queryByTestId('return-recommit-section')).toBeNull();
  });
});
