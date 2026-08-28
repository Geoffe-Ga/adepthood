/**
 * A permanently rejected check-in is a silent data loss until something tells
 * the user about it. The notice is a quiet, self-subscribing banner rather than
 * a toast, because ``loadHabits`` re-runs on every zone change and would fire a
 * toast repeatedly for one historical loss.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../services/habitManager', () => ({
  habitManager: {
    dismissDroppedCheckIns: jest.fn(() => Promise.resolve(undefined)),
  },
}));

import { habitManager } from '../../services/habitManager';
import DroppedCheckInNotice from '../DroppedCheckInNotice';

import type { DroppedCheckIn } from '@/storage/habitStorage';
import { useDroppedCheckInStore } from '@/store/useDroppedCheckInStore';

const NOTICE = 'dropped-check-in-notice';
const DISMISS = 'dismiss-dropped-check-ins';

function dropped(goalId: number): DroppedCheckIn {
  return {
    goal_id: goalId,
    did_complete: true,
    timestamp: '2025-04-01T00:00:00Z',
    status: 404,
    dropped_at: '2025-04-02T09:00:00Z',
  };
}

function seed(count: number): void {
  const entries = Array.from({ length: count }, (_unused, i) => dropped(100 + i));
  useDroppedCheckInStore.getState().setEntries(entries);
}

beforeEach(() => {
  useDroppedCheckInStore.getState().reset();
});

describe('DroppedCheckInNotice', () => {
  it('renders nothing while no check-in is quarantined', () => {
    const { queryByTestId } = render(<DroppedCheckInNotice />);

    expect(queryByTestId(NOTICE)).toBeNull();
    expect(queryByTestId(DISMISS)).toBeNull();
  });

  it('uses singular copy for a single lost check-in', () => {
    seed(1);

    const { getByText, queryByText } = render(<DroppedCheckInNotice />);

    expect(getByText('1 offline check-in could not be saved.')).toBeTruthy();
    expect(queryByText('1 offline check-ins could not be saved.')).toBeNull();
  });

  it('names the count and uses plural copy for three lost check-ins', () => {
    seed(3);

    const { getByText, queryByText } = render(<DroppedCheckInNotice />);

    expect(getByText('3 offline check-ins could not be saved.')).toBeTruthy();
    expect(queryByText('3 offline check-in could not be saved.')).toBeNull();
  });

  it('announces itself to a screen reader as an alert naming the loss', () => {
    seed(1);

    const { getByTestId } = render(<DroppedCheckInNotice />);

    const notice = getByTestId(NOTICE);
    expect(notice.props.accessibilityRole).toBe('alert');
    expect(notice.props.accessibilityLabel).toBe('1 offline check-in could not be saved.');
  });

  it('exposes Dismiss as a labelled button', () => {
    seed(2);

    const { getByTestId } = render(<DroppedCheckInNotice />);

    const dismiss = getByTestId(DISMISS);
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(dismiss.props.accessibilityLabel).toBe('Dismiss');
  });

  it('routes Dismiss through habitManager exactly once', () => {
    seed(2);
    const { getByTestId } = render(<DroppedCheckInNotice />);

    fireEvent.press(getByTestId(DISMISS));

    expect(habitManager.dismissDroppedCheckIns).toHaveBeenCalledTimes(1);
  });
});
