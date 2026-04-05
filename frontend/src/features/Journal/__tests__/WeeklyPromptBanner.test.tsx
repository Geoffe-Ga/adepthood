/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import type { PromptDetail } from '../../../api';
import WeeklyPromptBanner from '../WeeklyPromptBanner';

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
});
