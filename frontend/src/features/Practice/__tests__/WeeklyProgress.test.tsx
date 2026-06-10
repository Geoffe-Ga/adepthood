/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

// eslint-disable-next-line import/order
const { render } = require('@testing-library/react-native');
const WeeklyProgress = require('../WeeklyProgress').default;

describe('WeeklyProgress', () => {
  it('renders the weekly count as "X of 4"', () => {
    const { getByTestId } = render(<WeeklyProgress count={2} />);
    expect(getByTestId('week-count-text').props.children).toEqual([2, ' of ', 4]);
  });

  it('labels the metric so the count is self-explanatory', () => {
    const { getByText } = render(<WeeklyProgress count={2} />);
    expect(getByText('Practices this week')).toBeTruthy();
  });

  it('renders four segments, filling one per completed practice', () => {
    const { getByTestId } = render(<WeeklyProgress count={2} />);
    expect(getByTestId('progress-bar-fill')).toBeTruthy();
    expect(getByTestId('weekly-segment-0').props.accessibilityLabel).toBe('completed practice');
    expect(getByTestId('weekly-segment-1').props.accessibilityLabel).toBe('completed practice');
    expect(getByTestId('weekly-segment-2').props.accessibilityLabel).toBe('remaining practice');
    expect(getByTestId('weekly-segment-3').props.accessibilityLabel).toBe('remaining practice');
  });

  it('shows a helper line counting down remaining practices', () => {
    const { getByTestId } = render(<WeeklyProgress count={3} />);
    expect(getByTestId('weekly-helper').props.children).toBe(
      '1 more practice to reach your weekly goal.',
    );
  });

  it('uses the plural form when more than one practice remains', () => {
    const { getByTestId } = render(<WeeklyProgress count={1} />);
    expect(getByTestId('weekly-helper').props.children).toBe(
      '3 more practices to reach your weekly goal.',
    );
  });

  it('prompts the full goal from zero', () => {
    const { getByTestId } = render(<WeeklyProgress count={0} />);
    expect(getByTestId('week-count-text').props.children).toEqual([0, ' of ', 4]);
    expect(getByTestId('weekly-helper').props.children).toBe(
      'Complete 4 practices this week to reach your goal.',
    );
  });

  it('shows completion message when target is met', () => {
    const { getByTestId } = render(<WeeklyProgress count={4} />);
    expect(getByTestId('weekly-complete-message').props.children).toBe(
      'Weekly goal reached — nicely done.',
    );
  });

  it('does not show completion message when target is not met', () => {
    const { queryByTestId } = render(<WeeklyProgress count={3} />);
    expect(queryByTestId('weekly-complete-message')).toBeNull();
  });

  it('shows completion message and clamps the fill when count exceeds target', () => {
    const { getByTestId } = render(<WeeklyProgress count={6} />);
    expect(getByTestId('weekly-complete-message')).toBeTruthy();
    expect(getByTestId('week-count-text').props.children).toEqual([6, ' of ', 4]);
    expect(getByTestId('weekly-segment-3').props.accessibilityLabel).toBe('completed practice');
  });
});
