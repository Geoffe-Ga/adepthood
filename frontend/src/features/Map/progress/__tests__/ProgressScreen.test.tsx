import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { HELD_OVERVIEW_OPACITY, ProgressScreen } from '../ProgressScreen';

import type { ApiProgressOverview } from '@/api';
import { progressOverviewFixture } from '@/features/Map/testSupport/progressOverviewFixture';

interface Read {
  overview: ApiProgressOverview | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}
const mockRefresh = jest.fn(async () => undefined);
let mockRead: Read;
jest.mock('../useProgressOverview', () => ({ useProgressOverview: () => mockRead }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context') as object;
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

const read = (overrides: Partial<Read> = {}): Read => ({
  overview: progressOverviewFixture(),
  loading: false,
  error: null,
  refresh: mockRefresh,
  ...overrides,
});

beforeEach(() => {
  mockRead = read();
  mockRefresh.mockClear();
});

describe('ProgressScreen', () => {
  it('runs arc, rhythm, cycles, energy, in that order', () => {
    const tree = render(<ProgressScreen />);
    const order = ['progress-arc', 'progress-rhythm', 'progress-cycles', 'progress-energy'].map(
      (id) => JSON.stringify(tree.toJSON()).indexOf(`"testID":"${id}"`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(tree.getByTestId('progress-here')).toHaveTextContent('Week 23 · Yellow');
    expect(tree.getByTestId('progress-carryovers')).toHaveTextContent('Brought with you: 💧 Water');
    expect(tree.getByTestId('progress-energy-formula')).toHaveTextContent(
      'sum(return - cost) over completions',
    );
  });

  it('words the rhythm in facts, never a phase name', () => {
    const tree = render(<ProgressScreen />);
    expect(tree.getByTestId('progress-rhythm-caption')).toHaveTextContent(
      /^Your fullest fortnight was late June\. You rested from 3 August to 24 August\./,
    );
    expect(JSON.stringify(tree.toJSON())).not.toMatch(
      /streak|broken|missed|lost|expansion|contraction|peak|trough/i,
    );
  });

  it('holds the rhythm until four weeks of days', () => {
    const young = progressOverviewFixture();
    young.rhythm.days = young.rhythm.days.slice(0, 27);
    mockRead = read({ overview: young });
    const tree = render(<ProgressScreen />);
    expect(tree.getByTestId('progress-rhythm-early')).toHaveTextContent(
      'The rhythm view appears after four weeks.',
    );
    expect(tree.queryByTestId('progress-wave')).toBeNull();
  });

  it('shows the comparison only once there is a pass to compare with', () => {
    mockRead = read({ overview: progressOverviewFixture({ cycles: [] }) });
    expect(render(<ProgressScreen />).queryByTestId('progress-cycles')).toBeNull();
  });

  it('dims held figures while it re-reads, and retries an error', () => {
    mockRead = read({ loading: true });
    const held = render(<ProgressScreen />);
    expect(StyleSheet.flatten(held.getByTestId('progress-content').props.style)).toEqual({
      opacity: HELD_OVERVIEW_OPACITY,
    });
    mockRead = read({ overview: null, error: new Error('offline') });
    const failed = render(<ProgressScreen />);
    fireEvent.press(failed.getByTestId('progress-retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(failed.queryByTestId('progress-content')).toBeNull();
  });

  it('gives every chart a spoken summary', () => {
    const tree = render(<ProgressScreen />);
    for (const label of [
      /^The 36-week arc in ten stages\./,
      /^Your rhythm over 60 days/,
      /^Per stage, the share of scheduled days kept in cycle 1 and cycle 2\./,
      /^Net energy per week for 12 weeks/,
    ]) {
      expect(tree.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
  });
});
