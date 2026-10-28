import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { HELD_STORY_OPACITY } from '../HabitStory.styles';
import { HabitStorySheet } from '../HabitStorySheet';

import type { ApiHabitStory } from '@/api';
import { habitStoryFixture, storyHabit } from '@/features/Habits/testSupport/habitStoryFixture';

interface Read {
  story: ApiHabitStory | null;
  loading: boolean;
  error: Error | null;
  local: boolean;
  refresh: () => Promise<void>;
  timezone: string;
}
const mockRefresh = jest.fn(async () => undefined);
let mockRead: Read;
jest.mock('@/features/Habits/hooks/useHabitStory', () => ({
  useHabitStory: () => mockRead,
}));

const read = (overrides: Partial<Read> = {}): Read => ({
  story: habitStoryFixture(),
  loading: false,
  error: null,
  local: false,
  refresh: mockRefresh,
  timezone: 'UTC',
  ...overrides,
});
const withDaysWith = (days_with: number) => {
  const story = habitStoryFixture();
  return habitStoryFixture({ continuity: { ...story.continuity, days_with } });
};
const renderSheet = (onClose = jest.fn()) =>
  render(<HabitStorySheet visible habit={storyHabit()} onClose={onClose} />);

type Json = { props?: Record<string, unknown>; children?: (Json | string)[] | null };
/** Every host node in document order. */
function hostNodes(tree: ReturnType<typeof renderSheet>): Json[] {
  const out: Json[] = [];
  const walk = (node: Json | string | null | undefined) => {
    if (!node || typeof node === 'string') return;
    out.push(node);
    node.children?.forEach(walk);
  };
  const root = tree.toJSON() as Json | Json[] | null;
  (Array.isArray(root) ? root : [root]).forEach(walk);
  return out;
}

/** testIDs in document order, keeping only the sheet's own sections. */
function sectionOrder(tree: ReturnType<typeof renderSheet>): string[] {
  const ids = [
    'habit-story-glance',
    'habit-story-section-days',
    'habit-story-rate',
    'habit-story-section-tiers',
    'habit-story-section-patterns',
    'habit-story-observations',
    'habit-story-milestones',
    'habit-story-everything',
  ];
  return hostNodes(tree)
    .map((node) => node.props?.testID)
    .filter((id): id is string => typeof id === 'string' && ids.includes(id))
    .filter((id, index, all) => all.indexOf(id) === index);
}

beforeEach(() => {
  mockRead = read();
  mockRefresh.mockClear();
});

describe('HabitStorySheet', () => {
  it('runs top to bottom: Glance, grid, rate, tiers, patterns, notes, milestones, Everything', () => {
    mockRead = read({
      story: habitStoryFixture({
        observations: ['You have kept Morning pages on 45 of 51 scheduled days.'],
        milestones: [{ kind: 'return', reached_on: '2026-09-22', value: 3 }],
      }),
    });
    const tree = renderSheet();
    expect(tree.getByText('Morning pages')).toBeTruthy();
    expect(sectionOrder(tree)).toEqual([
      'habit-story-glance',
      'habit-story-section-days',
      'habit-story-rate',
      'habit-story-section-tiers',
      'habit-story-section-patterns',
      'habit-story-observations',
      'habit-story-milestones',
      'habit-story-everything',
    ]);
    expect(tree.getByText('Sep 22')).toBeTruthy();
    expect(tree.getByText('Back after 3 days. The record kept your place.')).toBeTruthy();
  });

  it('shows the four Glance tiles and the rate with its denominator', () => {
    const tree = renderSheet();
    const glance = tree.getByTestId('habit-story-glance');
    expect(within(glance).getByText('Current run')).toBeTruthy();
    expect(within(glance).getByText('7 days')).toBeTruthy();
    expect(within(glance).getByText('Longest run')).toBeTruthy();
    expect(within(glance).getByText('Returns')).toBeTruthy();
    expect(within(glance).getByText('of 51 scheduled')).toBeTruthy();
    expect(tree.getByTestId('habit-story-rate')).toHaveTextContent(
      '16 of 21 scheduled days in the last 21 days · all time 45 of 51',
    );
    expect(tree.getByTestId('habit-story-time-note')).toHaveTextContent(
      'Times are known for logs since Oct 1.',
    );
  });

  it.each([
    [6, false, false, false],
    [7, true, false, false],
    [14, true, true, false],
    [28, true, true, true],
  ])('at %i days with draws grid=%s stack=%s patterns=%s', (count, grid, stack, patterns) => {
    mockRead = read({ story: withDaysWith(count) });
    const tree = renderSheet();
    expect(tree.queryByTestId('habit-story-heat-grid') !== null).toBe(grid);
    expect(tree.queryByTestId('habit-story-tier-stack') !== null).toBe(stack);
    expect(tree.queryByTestId('habit-story-patterns') !== null).toBe(patterns);
    expect(tree.getByTestId('habit-story-rate')).toBeTruthy();
  });

  it('puts words where the charts would be in early days', () => {
    mockRead = read({ story: withDaysWith(3) });
    const tree = renderSheet();
    expect(
      within(tree.getByTestId('habit-story-observations')).getByText(
        '3 days with Morning pages so far. The shape appears here after 7.',
      ),
    ).toBeTruthy();
  });

  it('turns every chart into its table from the options menu, and back', () => {
    const tree = renderSheet();
    fireEvent.press(tree.getByTestId('habit-story-options'));
    fireEvent.press(tree.getByText('Show all as tables'));
    expect(tree.queryByTestId('habit-story-heat-grid')).toBeNull();
    expect(tree.queryByTestId('habit-story-tier-stack')).toBeNull();
    expect(tree.queryByTestId('habit-story-patterns')).toBeNull();
    expect(tree.getByText('Week of Oct 20')).toBeTruthy();
    expect(tree.getByText('Thu · Dawn · 8 pages')).toBeTruthy();
    fireEvent.press(tree.getByTestId('habit-story-options'));
    fireEvent.press(tree.getByText('Show all as charts'));
    expect(tree.getByTestId('habit-story-heat-grid')).toBeTruthy();
  });

  it('gives every chart a spoken summary', () => {
    const tree = renderSheet();
    const labels = hostNodes(tree)
      .filter((node) => node.props?.accessibilityRole === 'image')
      .map((node) => String(node.props?.accessibilityLabel));
    expect(labels.some((label) => label.startsWith('Morning pages, day by day from Sep 7'))).toBe(
      true,
    );
    expect(labels.some((label) => label.startsWith('Tier days per week for 2 weeks.'))).toBe(true);
    expect(labels.some((label) => label.includes('Most often on Thu Dawn.'))).toBe(true);
  });

  it('opens the Ledger from Everything and returns', () => {
    const tree = renderSheet();
    fireEvent.press(tree.getByTestId('habit-story-everything'));
    const ledger = tree.getByTestId('habit-ledger');
    expect(within(ledger).getByText('+2 pages')).toBeTruthy();
    expect(within(ledger).getByText('with the timer')).toBeTruthy();
    expect(within(ledger).getByText('−1 pages')).toBeTruthy();
    expect(tree.queryByTestId('habit-story-options')).toBeNull();
    fireEvent.press(tree.getByLabelText('Back to the story'));
    expect(tree.getByTestId('habit-story-glance')).toBeTruthy();
  });

  it('says so when there are no logs yet', () => {
    mockRead = read({ story: habitStoryFixture({ logs: [] }) });
    const tree = renderSheet();
    fireEvent.press(tree.getByTestId('habit-story-everything'));
    expect(tree.getByText('No logs yet.')).toBeTruthy();
  });

  it('holds the previous story dimmed while it re-reads, without a skeleton', () => {
    mockRead = read({ loading: true });
    const tree = renderSheet();
    expect(StyleSheet.flatten(tree.getByTestId('habit-story-content').props.style)).toEqual({
      opacity: HELD_STORY_OPACITY,
    });
    mockRead = read({ story: null, loading: true });
    tree.rerender(<HabitStorySheet visible habit={storyHabit()} onClose={jest.fn()} />);
    expect(tree.queryByTestId('habit-story-content')).toBeNull();
    expect(tree.queryByTestId('habit-story-options')).toBeNull();
  });

  it('shows the shared error fallback and retries', () => {
    mockRead = read({ story: null, error: new Error('offline') });
    const tree = renderSheet();
    expect(tree.getByText("This habit's story could not load.")).toBeTruthy();
    fireEvent.press(tree.getByTestId('habit-story-retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('marks a sample habit as local instead of reading it', () => {
    mockRead = read({ story: null, local: true });
    const tree = renderSheet();
    expect(tree.getByTestId('habit-story-sample')).toHaveTextContent(/This is a sample habit/);
  });

  it('closes from the corner and resets to the story floor', () => {
    const onClose = jest.fn();
    const tree = renderSheet(onClose);
    fireEvent.press(tree.getByTestId('habit-story-everything'));
    fireEvent.press(tree.getByTestId('habit-story-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tree.getByTestId('habit-story-glance')).toBeTruthy();
  });

  it('renders nothing without a habit', () => {
    const tree = render(<HabitStorySheet visible habit={null} onClose={jest.fn()} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('never says streak, broken, lost, missed or failed', () => {
    mockRead = read({
      story: habitStoryFixture({
        milestones: [
          { kind: 'return', reached_on: '2026-09-22', value: 3 },
          { kind: 'first_stretch', reached_on: '2026-09-23', value: 1 },
        ],
      }),
    });
    const tree = renderSheet();
    const text = JSON.stringify(tree.toJSON());
    expect(text).not.toMatch(/streak|broken|lost|missed|failed/i);
  });
});
