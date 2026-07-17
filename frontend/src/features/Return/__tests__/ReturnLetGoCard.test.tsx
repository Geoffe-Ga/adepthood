/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const mockListAll = jest.fn() as jest.MockedFunction<() => Promise<ApiHabitWithGoals[]>>;
jest.mock('@/api', () => ({
  habits: {
    listAll: (...args: unknown[]) =>
      (mockListAll as unknown as (...x: unknown[]) => unknown)(...args),
  },
}));

import { RETURN_LETGO_EMPTY, RETURN_LETGO_ERROR, buildReturnLetGoHabitA11y } from '../returnCopy';
import ReturnLetGoCard from '../ReturnLetGoCard';

import type { ApiHabitWithGoals } from '@/api';

function habit(overrides: Partial<ApiHabitWithGoals> = {}): ApiHabitWithGoals {
  return {
    id: 1,
    name: 'Morning pages',
    icon: '📓',
    start_date: '2026-01-01',
    energy_cost: 1,
    energy_return: 2,
    milestone_notifications: false,
    stage: 'aptitude',
    streak: 3,
    revealed: true,
    goals: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockListAll.mockReset();
});

describe('ReturnLetGoCard', () => {
  it('shows a loading state before the habit list resolves', () => {
    mockListAll.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<ReturnLetGoCard onRelease={jest.fn()} onSkip={jest.fn()} />);
    expect(getByTestId('return-letgo-loading')).toBeTruthy();
  });

  it('lists only revealed habits once loaded, hiding locked ones', async () => {
    mockListAll.mockResolvedValue([
      habit({ id: 1, name: 'Morning pages', revealed: true }),
      habit({ id: 2, name: 'Locked habit', revealed: false }),
    ]);
    const { getByTestId, queryByTestId } = render(
      <ReturnLetGoCard onRelease={jest.fn()} onSkip={jest.fn()} />,
    );
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());
    expect(queryByTestId('return-letgo-habit-2')).toBeNull();
  });

  it('carries the card testID once loaded', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, revealed: true })]);
    const { getByTestId } = render(<ReturnLetGoCard onRelease={jest.fn()} onSkip={jest.fn()} />);
    await waitFor(() => expect(getByTestId('return-letgo-card')).toBeTruthy());
  });

  it('builds the per-habit selection a11y label from the habit name', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, name: 'Morning pages', revealed: true })]);
    const { getByTestId } = render(<ReturnLetGoCard onRelease={jest.fn()} onSkip={jest.fn()} />);
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());
    expect(getByTestId('return-letgo-habit-1').props.accessibilityLabel).toBe(
      buildReturnLetGoHabitA11y('Morning pages'),
    );
  });

  it('selecting habits then pressing Release calls onRelease with only the chosen ids', async () => {
    mockListAll.mockResolvedValue([
      habit({ id: 1, name: 'Morning pages', revealed: true }),
      habit({ id: 2, name: 'Evening walk', revealed: true }),
    ]);
    const onRelease = jest.fn();
    const { getByTestId } = render(<ReturnLetGoCard onRelease={onRelease} onSkip={jest.fn()} />);
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());

    fireEvent.press(getByTestId('return-letgo-habit-1'));
    fireEvent.press(getByTestId('return-letgo-release'));

    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith([1]);
  });

  it('toggling a selected habit back to empty disables Release so it cannot fire empty', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, name: 'Morning pages', revealed: true })]);
    const onRelease = jest.fn();
    const { getByTestId } = render(<ReturnLetGoCard onRelease={onRelease} onSkip={jest.fn()} />);
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());

    fireEvent.press(getByTestId('return-letgo-habit-1'));
    fireEvent.press(getByTestId('return-letgo-habit-1'));
    fireEvent.press(getByTestId('return-letgo-release'));

    expect(getByTestId('return-letgo-release').props.accessibilityState.disabled).toBe(true);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('disables Release while nothing is selected, so an empty release can never be sent', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, name: 'Morning pages', revealed: true })]);
    const onRelease = jest.fn();
    const { getByTestId } = render(<ReturnLetGoCard onRelease={onRelease} onSkip={jest.fn()} />);
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());

    expect(getByTestId('return-letgo-release').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(getByTestId('return-letgo-release'));
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('enables Release once at least one habit is selected', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, name: 'Morning pages', revealed: true })]);
    const { getByTestId } = render(<ReturnLetGoCard onRelease={jest.fn()} onSkip={jest.fn()} />);
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());

    fireEvent.press(getByTestId('return-letgo-habit-1'));

    expect(getByTestId('return-letgo-release').props.accessibilityState.disabled).toBe(false);
  });

  it('"Keep them all" calls onSkip and never onRelease', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, revealed: true })]);
    const onRelease = jest.fn();
    const onSkip = jest.fn();
    const { getByTestId } = render(<ReturnLetGoCard onRelease={onRelease} onSkip={onSkip} />);
    await waitFor(() => expect(getByTestId('return-letgo-habit-1')).toBeTruthy());

    fireEvent.press(getByTestId('return-letgo-skip'));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('shows the empty-state line and still offers to skip when no habits are revealed', async () => {
    mockListAll.mockResolvedValue([habit({ id: 1, revealed: false })]);
    const onSkip = jest.fn();
    const { getByText, getByTestId, queryByTestId } = render(
      <ReturnLetGoCard onRelease={jest.fn()} onSkip={onSkip} />,
    );
    await waitFor(() => expect(getByText(RETURN_LETGO_EMPTY)).toBeTruthy());
    expect(queryByTestId('return-letgo-habit-1')).toBeNull();

    fireEvent.press(getByTestId('return-letgo-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('shows the distinct load-error line (not the empty line) when the list fails to load', async () => {
    mockListAll.mockRejectedValue(new Error('network down'));
    const { getByText, queryByText, queryByTestId } = render(
      <ReturnLetGoCard onRelease={jest.fn()} onSkip={jest.fn()} />,
    );
    await waitFor(() => expect(getByText(RETURN_LETGO_ERROR)).toBeTruthy());
    // A flaky connection must never read as "you have nothing to release."
    expect(queryByText(RETURN_LETGO_EMPTY)).toBeNull();
    expect(queryByTestId('return-letgo-error')).toBeTruthy();
  });

  it('still offers to skip after a failed load so the moment stays declinable', async () => {
    mockListAll.mockRejectedValue(new Error('network down'));
    const onSkip = jest.fn();
    const { getByTestId } = render(<ReturnLetGoCard onRelease={jest.fn()} onSkip={onSkip} />);
    await waitFor(() => expect(getByTestId('return-letgo-error')).toBeTruthy());

    fireEvent.press(getByTestId('return-letgo-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
