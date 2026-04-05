/* eslint-env jest */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import type { PracticeItem } from '../../../api';

const samplePractices: PracticeItem[] = [
  {
    id: 1,
    stage_number: 1,
    name: 'Breath Awareness',
    description: 'Focus on the breath to develop concentration.',
    instructions: 'Sit comfortably and focus on your breathing.',
    default_duration_minutes: 10,
    submitted_by_user_id: null,
    approved: true,
  },
  {
    id: 2,
    stage_number: 1,
    name: 'Body Scan',
    description: 'Progressively scan through body sensations.',
    instructions: 'Start at the crown and slowly move attention downward.',
    default_duration_minutes: 15,
    submitted_by_user_id: null,
    approved: true,
  },
];

// eslint-disable-next-line import/order
const { render, fireEvent } = require('@testing-library/react-native');
const PracticeSelector = require('../PracticeSelector').default;

describe('PracticeSelector', () => {
  const mockOnSelect = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows loading indicator when isLoading is true', () => {
    const { getByTestId } = render(
      <PracticeSelector
        practices={[]}
        selectedPracticeId={null}
        onSelect={mockOnSelect}
        isLoading={true}
      />,
    );
    expect(getByTestId('selector-loading')).toBeTruthy();
  });

  it('shows empty message when no practices available', () => {
    const { getByTestId, getByText } = render(
      <PracticeSelector
        practices={[]}
        selectedPracticeId={null}
        onSelect={mockOnSelect}
        isLoading={false}
      />,
    );
    expect(getByTestId('selector-empty')).toBeTruthy();
    expect(getByText('No practices available for this stage yet.')).toBeTruthy();
  });

  it('renders practice cards with name and description', () => {
    const { getByText } = render(
      <PracticeSelector
        practices={samplePractices}
        selectedPracticeId={null}
        onSelect={mockOnSelect}
        isLoading={false}
      />,
    );
    expect(getByText('Breath Awareness')).toBeTruthy();
    expect(getByText('Focus on the breath to develop concentration.')).toBeTruthy();
    expect(getByText('Body Scan')).toBeTruthy();
    expect(getByText('10 min per session')).toBeTruthy();
    expect(getByText('15 min per session')).toBeTruthy();
  });

  it('shows select button for unselected practices', () => {
    const { getByTestId } = render(
      <PracticeSelector
        practices={samplePractices}
        selectedPracticeId={null}
        onSelect={mockOnSelect}
        isLoading={false}
      />,
    );
    expect(getByTestId('select-practice-1')).toBeTruthy();
    expect(getByTestId('select-practice-2')).toBeTruthy();
  });

  it('calls onSelect with practice id when select button is pressed', () => {
    const { getByTestId } = render(
      <PracticeSelector
        practices={samplePractices}
        selectedPracticeId={null}
        onSelect={mockOnSelect}
        isLoading={false}
      />,
    );
    fireEvent.press(getByTestId('select-practice-1'));
    expect(mockOnSelect).toHaveBeenCalledWith(1);
  });

  it('shows checkmark for selected practice and hides select button', () => {
    const { getByTestId, queryByTestId } = render(
      <PracticeSelector
        practices={samplePractices}
        selectedPracticeId={1}
        onSelect={mockOnSelect}
        isLoading={false}
      />,
    );
    expect(getByTestId('selected-checkmark')).toBeTruthy();
    expect(queryByTestId('select-practice-1')).toBeNull();
    // Second practice still has select button
    expect(getByTestId('select-practice-2')).toBeTruthy();
  });

  it('renders the heading', () => {
    const { getByText } = render(
      <PracticeSelector
        practices={samplePractices}
        selectedPracticeId={null}
        onSelect={mockOnSelect}
        isLoading={false}
      />,
    );
    expect(getByText('Choose a Practice')).toBeTruthy();
  });
});
