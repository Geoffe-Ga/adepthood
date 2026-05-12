/* eslint-env jest */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import React from 'react';

import type { PromptDetail } from '../../../api';
import { useProgramStore } from '../../../store/useProgramStore';
import WeeklyPromptBanner from '../WeeklyPromptBanner';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  act(() => useProgramStore.getState().hydrateProgramStartDate(null));
});

const samplePrompt: PromptDetail = {
  week_number: 3,
  question: 'What are you most grateful for this week?',
  has_responded: false,
  response: null,
  timestamp: null,
};

describe('WeeklyPromptBanner', () => {
  it('displays the week number and question', () => {
    const { getByText } = render(
      <WeeklyPromptBanner prompt={samplePrompt} onRespond={jest.fn()} />,
    );
    expect(getByText('Week 3 Reflection')).toBeTruthy();
    expect(getByText('What are you most grateful for this week?')).toBeTruthy();
  });

  it('shows a respond button', () => {
    const { getByText } = render(
      <WeeklyPromptBanner prompt={samplePrompt} onRespond={jest.fn()} />,
    );
    expect(getByText('Respond')).toBeTruthy();
  });

  it('calls onRespond when respond button is pressed', () => {
    const onRespond = jest.fn();
    const { getByTestId } = render(
      <WeeklyPromptBanner prompt={samplePrompt} onRespond={onRespond} />,
    );
    fireEvent.press(getByTestId('prompt-respond-button'));
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it('overrides the displayed week with the master program anchor when set', () => {
    // Anchor 14 days ago -> week 3 by the date-driven rule, regardless of
    // what the server-supplied ``prompt.week_number`` says.
    const today = new Date();
    const anchor = new Date(today);
    anchor.setDate(anchor.getDate() - 14);
    act(() => useProgramStore.getState().hydrateProgramStartDate(anchor));

    const promptOnWeek1: PromptDetail = { ...samplePrompt, week_number: 1 };
    const { getByText } = render(
      <WeeklyPromptBanner prompt={promptOnWeek1} onRespond={jest.fn()} />,
    );
    expect(getByText('Week 3 Reflection')).toBeTruthy();
  });
});
