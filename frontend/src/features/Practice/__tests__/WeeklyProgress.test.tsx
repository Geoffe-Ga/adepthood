/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

// eslint-disable-next-line import/order
const { render } = require('@testing-library/react-native');
const WeeklyProgress = require('../WeeklyProgress').default;

describe('WeeklyProgress', () => {
  it('renders the weekly count text', () => {
    const { getByTestId } = render(<WeeklyProgress count={2} />);
    expect(getByTestId('week-count-text').props.children).toEqual([2, '/', 4]);
  });

  it('renders progress bar fill', () => {
    const { getByTestId } = render(<WeeklyProgress count={2} />);
    const fill = getByTestId('progress-bar-fill');
    expect(fill).toBeTruthy();
  });

  it('shows completion message when target is met', () => {
    const { getByTestId } = render(<WeeklyProgress count={4} />);
    expect(getByTestId('weekly-complete-message')).toBeTruthy();
  });

  it('does not show completion message when target is not met', () => {
    const { queryByTestId } = render(<WeeklyProgress count={3} />);
    expect(queryByTestId('weekly-complete-message')).toBeNull();
  });

  it('shows completion message when count exceeds target', () => {
    const { getByTestId } = render(<WeeklyProgress count={6} />);
    expect(getByTestId('weekly-complete-message')).toBeTruthy();
    expect(getByTestId('week-count-text').props.children).toEqual([6, '/', 4]);
  });

  it('renders with zero count', () => {
    const { getByTestId } = render(<WeeklyProgress count={0} />);
    expect(getByTestId('week-count-text').props.children).toEqual([0, '/', 4]);
    expect(getByTestId('weekly-progress')).toBeTruthy();
  });
});
