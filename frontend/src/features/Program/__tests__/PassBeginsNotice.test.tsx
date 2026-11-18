import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';

import { useProgramStore } from '../../../store/useProgramStore';
import { PassBeginsNotice } from '../PassBeginsNotice';

jest.mock('../../../storage/programStorage', () => ({
  loadProgramStartDate: jest.fn(() => Promise.resolve(null)),
  saveProgramStartDate: jest.fn(() => Promise.resolve()),
  clearProgramStartDate: jest.fn(() => Promise.resolve()),
}));

const ZONE = 'America/New_York';
// Noon in New York on 2026-11-15.
const NOW = new Date('2026-11-15T17:00:00Z');
const RUNNING_DAY = '2026-09-13';
const FUTURE_DAY = '2026-12-01';
const NOT_YET_DAYS = 13;
const NOT_YET_DAY = '2026-11-28';

const hold = (state: Partial<ReturnType<typeof useProgramStore.getState>>) =>
  act(() => {
    useProgramStore.setState(state);
  });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  act(() => useProgramStore.getState().reset());
  jest.useRealTimers();
});

describe('PassBeginsNotice (#3728)', () => {
  it('renders nothing when no pass is waiting to begin', () => {
    hold({ programStartDay: RUNNING_DAY });

    const result = render(<PassBeginsNotice tz={ZONE} />);

    expect(result.queryByTestId('pass-begins-notice')).toBeNull();
  });

  it('names the day the next pass begins, with no call to action', () => {
    hold({ programStartDay: RUNNING_DAY, pendingPassStartsOn: FUTURE_DAY });

    const result = render(<PassBeginsNotice tz={ZONE} />);

    expect(result.getByTestId('pass-begins-notice')).toHaveTextContent(
      'Your next pass begins December 1, 2026.',
    );
    expect(result.queryByRole('button')).toBeNull();
  });

  it('counts down to a first pass placed in the future', () => {
    hold({ programStartDay: NOT_YET_DAY, daysUntilStart: NOT_YET_DAYS });

    const result = render(<PassBeginsNotice tz={ZONE} />);

    expect(result.getByTestId('pass-begins-notice')).toHaveTextContent(
      'Your program begins November 28, in 13 days.',
    );
  });

  it('says tomorrow rather than "in 1 days"', () => {
    hold({ programStartDay: '2026-11-16', daysUntilStart: 1 });

    const result = render(<PassBeginsNotice tz={ZONE} />);

    expect(result.getByTestId('pass-begins-notice')).toHaveTextContent(
      'Your program begins November 16, tomorrow.',
    );
  });

  it('counts from today, not from the read, so a stale countdown never overstates', () => {
    // The read said 13 days, but it is now the day itself: nothing is waiting.
    hold({ programStartDay: '2026-11-15', daysUntilStart: NOT_YET_DAYS });

    const result = render(<PassBeginsNotice tz={ZONE} />);

    expect(result.queryByTestId('pass-begins-notice')).toBeNull();
  });

  it('retracts once the held day has come, before the next read settles it', () => {
    hold({ programStartDay: RUNNING_DAY, pendingPassStartsOn: '2026-11-15' });

    const result = render(<PassBeginsNotice tz={ZONE} />);

    expect(result.queryByTestId('pass-begins-notice')).toBeNull();
  });
});
