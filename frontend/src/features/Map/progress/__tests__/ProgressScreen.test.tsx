import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

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
  it('keeps all sections in the scroll container when the arc table expands', () => {
    const tree = render(<ProgressScreen />);
    const scroller = tree.UNSAFE_getByType(ScrollView);
    fireEvent.press(within(tree.getByTestId('progress-ribbon')).getByRole('button'));
    expect(within(scroller).getByText('Weeks 1–3')).toBeTruthy();
    expect(within(scroller).getByTestId('progress-energy-columns')).toBeTruthy();
  });

  it('runs arc, rhythm, cycles, habits, energy, in that order', () => {
    const tree = render(<ProgressScreen />);
    const order = [
      'progress-arc',
      'progress-rhythm',
      'progress-cycles',
      'progress-habits',
      'progress-energy',
    ].map((id) => JSON.stringify(tree.toJSON()).indexOf(`"testID":"${id}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(within(tree.getByTestId('progress-ribbon')).getByText('Week 23 · Yellow')).toBeTruthy();
  });

  it('says each thing once: no lead, no formula, no axis captions, no hover hints', () => {
    const json = JSON.stringify(render(<ProgressScreen />).toJSON());
    for (const gone of [
      'Where you are in the arc',
      'sum(return - cost)',
      'Below zero means',
      'Units logged',
      'Hover or tap',
      '"Date"',
    ]) {
      expect(json).not.toContain(gone);
    }
  });

  it('opens every table twin from a named glyph', () => {
    const tree = render(<ProgressScreen />);
    const toggles = tree.getAllByRole('button', { name: 'Show as table' });
    expect(toggles.length).toBeGreaterThanOrEqual(4);
    fireEvent.press(within(tree.getByTestId('progress-energy-columns')).getByRole('button'));
    expect(
      within(tree.getByTestId('progress-energy-columns')).getByRole('button', {
        name: 'Show chart',
      }),
    ).toBeTruthy();
  });

  it('draws only logged habits, each with its current 7-day average', () => {
    const tree = render(<ProgressScreen />);
    const habits = within(tree.getByTestId('progress-habits'));
    expect(habits.getByText('7-day averages, 18 May to 19 May.')).toBeTruthy();
    expect(habits.getByText('Morning pages')).toBeTruthy();
    expect(habits.getByText('1 pages a day')).toBeTruthy();
    expect(habits.queryByText('Evening walk')).toBeNull();
    expect(tree.queryByTestId('progress-carryovers')).toBeNull();
    expect(tree.queryByTestId('progress-habit-1-pages-value')).toBeNull();
    fireEvent.press(tree.getByTestId('progress-habit-1-pages-inspect'), {
      nativeEvent: { locationX: 1000 },
    });
    expect(tree.getByTestId('progress-habit-1-pages-value')).toHaveTextContent(
      '19 May 2026 · 1 pages a day · 2 logged that day',
    );
  });

  it('keeps carryovers apart once they have a line to draw', () => {
    const overview = progressOverviewFixture();
    overview.arc.habit_births[2]!.unit_histories = [
      { unit: 'glasses', days: [{ date: '2026-05-18', units: 8, average: 8 }] },
    ];
    mockRead = read({ overview });
    const brought = within(render(<ProgressScreen />).getByTestId('progress-carryovers'));
    expect(brought.getByText('Brought with you')).toBeTruthy();
    expect(brought.getByText('Water')).toBeTruthy();
  });

  it('heads the wave with its latest share and reads the latest point by default', () => {
    const tree = render(<ProgressScreen />);
    const wave = within(tree.getByTestId('progress-wave'));
    expect(wave.getByText('Scheduled kept, last 7 days')).toBeTruthy();
    expect(tree.getByTestId('progress-wave-value')).toHaveTextContent(/ · \d+% · 14 of 21 kept$/);
  });

  it('words the rhythm in facts, never a phase name', () => {
    const tree = render(<ProgressScreen />);
    expect(tree.getByTestId('progress-rhythm-caption')).toHaveTextContent(
      /^Your fullest week was late June\. You rested from 3 August to 24 August\./,
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
      /^Per stage, the share of scheduled asks kept in cycle 1 and cycle 2\./,
      /^Net energy for 12 weeks/,
    ]) {
      expect(tree.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
  });
});
