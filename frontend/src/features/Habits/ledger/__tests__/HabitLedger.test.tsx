import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import { HabitLedger } from '../HabitLedger';

import type { ApiHabitStory } from '@/api';
import { createHabitStoryStyles } from '@/features/Habits/story/HabitStory.styles';
import { habitStoryFixture, storyDays } from '@/features/Habits/testSupport/habitStoryFixture';

const mockSave = jest.fn(async (filename: string, _contents: string, _type: string) => ({
  filename,
  uri: null,
  destination: 'browser-download' as const,
}));
jest.mock('@/features/Settings/saveDataExport', () => ({
  saveTextFile: (filename: string, contents: string, type: string) =>
    mockSave(filename, contents, type),
}));

const styles = createHabitStoryStyles(390);
const renderLedger = (story: ApiHabitStory = habitStoryFixture()) =>
  render(<HabitLedger story={story} habitName="Morning pages" timezone="UTC" styles={styles} />);

const SECTIONS = [
  'habit-ledger-stages',
  'habit-ledger-continuity',
  'habit-ledger-tiers',
  'habit-ledger-patterns',
  'habit-ledger-logs',
  'habit-ledger-export',
];

describe('HabitLedger', () => {
  beforeEach(() => {
    mockSave.mockClear();
  });

  it('lays the record out in its fixed section order', () => {
    const tree = renderLedger();
    const ledger = tree.getByTestId('habit-ledger');
    const root = tree.toJSON() as { children: { props: { testID?: string } }[] };
    expect(root.children.map((child) => child.props.testID)).toEqual(SECTIONS);
    expect(
      within(ledger)
        .getAllByRole('header')
        .map((node) => node.props.children),
    ).toEqual(['By stage', 'Continuity', 'Tiers', 'Patterns', 'Logs', 'Export']);
  });

  it('prints every rate window with its denominator', () => {
    const continuity = renderLedger().getByTestId('habit-ledger-continuity');
    expect(within(continuity).getByText('16 of 21 scheduled days (76%)')).toBeTruthy();
    expect(within(continuity).getByText('45 of 51 scheduled days (88%)')).toBeTruthy();
    expect(within(continuity).getByText('15 days')).toBeTruthy();
  });

  it('labels a subtractive habit’s tiers as limits it stayed within', () => {
    const tiers = renderLedger(habitStoryFixture({ polarity: 'subtractive' })).getByTestId(
      'habit-ledger-tiers',
    );
    expect(within(tiers).getAllByText('Within Clear limit').length).toBeGreaterThan(0);
    expect(within(tiers).getAllByText('Over').length).toBeGreaterThan(0);
    expect(within(tiers).queryByText('Under Low')).toBeNull();
  });

  it('names a strip per stage and the time-not-recorded row', () => {
    const tree = renderLedger();
    const stages = tree.getByTestId('habit-ledger-stages');
    expect(within(stages).getByText('Beige')).toBeTruthy();
    expect(within(stages).getByText('Red')).toBeTruthy();
    expect(
      within(tree.getByTestId('habit-ledger-patterns')).getByText('Time not recorded'),
    ).toBeTruthy();
  });

  it('groups logs by day with each day’s total', () => {
    const tree = renderLedger();
    const day = tree.getByTestId('habit-ledger-day-2026-10-27');
    expect(within(day).getByText('Tue, Oct 27, 2026 · 2 pages')).toBeTruthy();
    expect(within(day).getByText(/2:05/)).toBeTruthy();
    expect(within(day).getByText('+2 pages')).toBeTruthy();
    expect(
      within(tree.getByTestId('habit-ledger-day-2026-10-26')).getByText('−1 pages'),
    ).toBeTruthy();
  });

  it('shows untimed units as time not recorded under their day', () => {
    const story = habitStoryFixture({
      logs: [],
      days: storyDays('2026-10-23', 1, [{ unknown_time_units: 48, units: 48 }]),
    });
    const day = renderLedger(story).getByTestId('habit-ledger-day-2026-10-23');
    expect(within(day).getByText('Time not recorded')).toBeTruthy();
    expect(within(day).getByText('48 pages')).toBeTruthy();
  });

  it('says so when there are no logs and no stages', () => {
    const tree = renderLedger(habitStoryFixture({ logs: [], stages: [] }));
    expect(tree.getByText('No logs yet.')).toBeTruthy();
    expect(tree.getByText('No stage has opened yet.')).toBeTruthy();
  });

  it('pages logs fifty at a time', () => {
    const logs = Array.from({ length: 60 }, (_, index) => ({
      timestamp: `2026-10-27T${String(index % 24).padStart(2, '0')}:00:00Z`,
      local_day: '2026-10-27',
      delta_units: 1,
      via_timer: false,
      source: 'manual',
    }));
    const tree = renderLedger(habitStoryFixture({ logs }));
    expect(tree.getAllByTestId('habit-ledger-log')).toHaveLength(50);
    fireEvent.press(tree.getByTestId('habit-ledger-more'));
    expect(tree.getAllByTestId('habit-ledger-log')).toHaveLength(60);
    expect(tree.queryByTestId('habit-ledger-more')).toBeNull();
  });

  it('exports CSV and JSON through the data-export path and names the file', async () => {
    const tree = renderLedger();
    await act(async () => fireEvent.press(tree.getByText('Export CSV')));
    expect(mockSave).toHaveBeenCalledWith(
      'adepthood-morning-pages-2026-10-27.csv',
      expect.stringContaining('# days'),
      'text/csv;charset=utf-8',
    );
    expect(tree.getByTestId('habit-ledger-export-saved').props.children).toBe(
      'Saved adepthood-morning-pages-2026-10-27.csv',
    );
    await act(async () => fireEvent.press(tree.getByText('Export JSON')));
    expect(mockSave).toHaveBeenLastCalledWith(
      'adepthood-morning-pages-2026-10-27.json',
      expect.stringContaining('"habit": "Morning pages"'),
      'application/json;charset=utf-8',
    );
  });

  it('says so when the file could not be saved', async () => {
    mockSave.mockRejectedValueOnce(new Error('no disk'));
    const tree = renderLedger();
    await act(async () => fireEvent.press(tree.getByText('Export CSV')));
    expect(tree.getByText('The file could not be saved. Try again.')).toBeTruthy();
  });
});
