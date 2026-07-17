/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockDismissOffer = jest.fn();
const mockStart = jest.fn();
const mockPause = jest.fn();
const mockResume = jest.fn();
const mockLeave = jest.fn();
const mockSkipLetGo = jest.fn();
const mockRelease = jest.fn();
const mockRecommit = jest.fn();
let mockMettaReturn: {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offerVisible: boolean;
  letGoVisible?: boolean;
  releasedHabits?: ReleasedHabit[];
};
jest.mock('../useMettaReturn', () => ({
  useMettaReturn: () => ({
    ...mockMettaReturn,
    dismissOffer: mockDismissOffer,
    start: mockStart,
    pause: mockPause,
    resume: mockResume,
    leave: mockLeave,
    skipLetGo: mockSkipLetGo,
    release: mockRelease,
    recommit: mockRecommit,
  }),
}));

import ReturnStack from '../ReturnStack';

import type { ReleasedHabit, ReturnArc, ReturnWeek } from '@/api';

const makeWeek = (weekNumber: number): ReturnWeek => ({
  week_number: weekNumber,
  focus: 'self',
  title: `Toward yourself, week ${weekNumber}`,
  framing: 'Begin where you already are.',
});

const makeArc = (weekNumber: number, complete = false, paused = false): ReturnArc => ({
  started_at: '2026-06-24T00:00:00Z',
  paused,
  week: weekNumber,
  focus: 'self',
  complete,
});

beforeEach(() => {
  mockDismissOffer.mockClear();
  mockStart.mockClear();
  mockPause.mockClear();
  mockResume.mockClear();
  mockLeave.mockClear();
  mockSkipLetGo.mockClear();
  mockRelease.mockClear();
  mockRecommit.mockClear();
  mockMettaReturn = {
    eligible: false,
    weeks: [],
    arc: null,
    offerVisible: false,
    letGoVisible: false,
    releasedHabits: [],
  };
});

describe('ReturnStack', () => {
  it('renders nothing with no active arc and no visible offer', () => {
    const { toJSON } = render(<ReturnStack />);
    expect(toJSON()).toBeNull();
  });

  it('shows the completion card, not the arc card, when the arc is complete', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(5)],
      arc: makeArc(5, true),
      offerVisible: false,
    };
    const { getByTestId, queryByTestId } = render(<ReturnStack />);
    expect(getByTestId('return-completion-card')).toBeTruthy();
    expect(queryByTestId('return-arc-card')).toBeNull();
    fireEvent.press(getByTestId('return-completion-leave'));
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  it('shows the arc card, not the completion card, when the arc is active and not complete', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(2)],
      arc: makeArc(2),
      offerVisible: false,
    };
    const { getByTestId, queryByTestId } = render(<ReturnStack />);
    expect(getByTestId('return-arc-card')).toBeTruthy();
    expect(queryByTestId('return-completion-card')).toBeNull();
  });

  it('pauses the active arc when the pause action is pressed', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(2)],
      arc: makeArc(2),
      offerVisible: false,
    };
    const { getByTestId } = render(<ReturnStack />);
    fireEvent.press(getByTestId('return-arc-pause'));
    expect(mockPause).toHaveBeenCalledTimes(1);
  });

  it('resumes a paused arc when the resume action is pressed', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(2)],
      arc: makeArc(2, false, true),
      offerVisible: false,
    };
    const { getByTestId } = render(<ReturnStack />);
    fireEvent.press(getByTestId('return-arc-resume'));
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it('leaves the active arc when the leave action is pressed', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(2)],
      arc: makeArc(2),
      offerVisible: false,
    };
    const { getByTestId } = render(<ReturnStack />);
    fireEvent.press(getByTestId('return-arc-leave'));
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  it('shows the offer card when there is no arc and the offer is visible', () => {
    mockMettaReturn = { eligible: true, weeks: [makeWeek(1)], arc: null, offerVisible: true };
    const { getByTestId } = render(<ReturnStack />);
    expect(getByTestId('return-offer-card')).toBeTruthy();
  });

  it('starts the arc when the offer is accepted', () => {
    mockMettaReturn = { eligible: true, weeks: [makeWeek(1)], arc: null, offerVisible: true };
    const { getByTestId } = render(<ReturnStack />);
    fireEvent.press(getByTestId('return-offer-accept'));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('dismisses the offer when it is declined', () => {
    mockMettaReturn = { eligible: true, weeks: [makeWeek(1)], arc: null, offerVisible: true };
    const { getByTestId } = render(<ReturnStack />);
    fireEvent.press(getByTestId('return-offer-dismiss'));
    expect(mockDismissOffer).toHaveBeenCalledTimes(1);
  });

  it('shows the let-go card ahead of the arc card when active, not complete, and letGoVisible', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(1)],
      arc: makeArc(1),
      offerVisible: false,
      letGoVisible: true,
      releasedHabits: [],
    };
    const { getByTestId } = render(<ReturnStack />);
    expect(getByTestId('return-letgo-card')).toBeTruthy();
  });

  it('does not show the let-go card once the arc is complete, even if letGoVisible is stale-true', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(5)],
      arc: makeArc(5, true),
      offerVisible: false,
      letGoVisible: true,
      releasedHabits: [],
    };
    const { queryByTestId } = render(<ReturnStack />);
    expect(queryByTestId('return-letgo-card')).toBeNull();
  });

  it('does not show the let-go card when letGoVisible is false', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(1)],
      arc: makeArc(1),
      offerVisible: false,
      letGoVisible: false,
      releasedHabits: [],
    };
    const { queryByTestId } = render(<ReturnStack />);
    expect(queryByTestId('return-letgo-card')).toBeNull();
  });
});
