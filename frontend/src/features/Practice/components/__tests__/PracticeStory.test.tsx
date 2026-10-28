import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { Circle } from 'react-native-svg';

import { PracticeStory } from '../PracticeStory';
import { formatPracticeMinutes, formatCalendarDate } from '../PracticeStory.presentation';

import { accent, surface } from '@/design/tokens';
import { storyFixture } from '@/features/Practice/testSupport/practiceStoryFixture';

describe('Practice Story', () => {
  it('is absent for an unadopted practice', () => {
    expect(
      render(<PracticeStory story={null} stageName="Teal" timezone="UTC" />).toJSON(),
    ).toBeNull();
  });
  it('leads with lifetime hours, then cadence, sits, when, how and observations', () => {
    const screen = render(<PracticeStory story={storyFixture()} stageName="Teal" timezone="UTC" />);
    expect(screen.getByTestId('practice-story-time')).toHaveTextContent('1 h 5 m');
    expect(screen.getByText('in practice · 2 sits')).toBeTruthy();
    const sections = screen
      .getAllByTestId(/^practice-story-section-/)
      .map((node) => node.props.testID);
    expect(sections).toEqual([
      'practice-story-section-weekly',
      'practice-story-section-sits',
      'practice-story-section-time-of-day',
      'practice-story-section-modes',
      'practice-story-section-insight',
      'practice-story-section-observations',
      'practice-story-section-milestones',
    ]);
    expect(
      screen.getByText(
        '1 of 2 sits this stage ended early; every minute counts toward your hours.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Teal asks 45 min')).toBeTruthy();
    expect(
      screen.UNSAFE_getAllByType(Circle).find((node) => node.props.testID === 'dot-strip-point-0')
        ?.props.fill,
    ).toBe(accent.primary);
    expect(
      screen.UNSAFE_getAllByType(Circle).find((node) => node.props.testID === 'dot-strip-point-1')
        ?.props.fill,
    ).toBe(surface.canvas);
  });
  it('offers all raw table twins from overflow, retaining fractional minutes and calendar dates', () => {
    const story = storyFixture();
    story.recent_sits[1]!.duration_minutes = 0.25;
    const screen = render(
      <PracticeStory story={story} stageName="Teal" timezone="America/Los_Angeles" />,
    );
    fireEvent.press(screen.getByLabelText('Practice record options'));
    fireEvent.press(screen.getByText('Show all tables'));
    expect(
      within(screen.getByTestId('practice-story-section-sits')).getByText('0.25'),
    ).toBeTruthy();
    expect(screen.getAllByText('Ended early')).toHaveLength(1);
    expect(screen.getAllByText('Oct 19, 2026').length).toBeGreaterThan(0);
    expect(screen.getByText('Oct 25, 2026')).toBeTruthy();
  });
  it.each<[string, 'Minutes' | 'Sits', number]>([
    ['sits', 'Minutes', 2],
    ['time-of-day', 'Sits', 4],
    ['modes', 'Sits', 2],
  ])('labels each chart table with native units (%s)', (sectionName, header, rows) => {
    const screen = render(<PracticeStory story={storyFixture()} stageName="Teal" timezone="UTC" />);
    const section = within(screen.getByTestId(`practice-story-section-${sectionName}`));

    fireEvent.press(section.getByRole('button', { name: 'Show as table' }));

    expect(section.getAllByText(header)).toHaveLength(rows);
    expect(section.queryByText('Value')).toBeNull();
  });
  it('shows modes only when two are known and tolerates missing optional sections', () => {
    const story = storyFixture();
    story.modes = { meditation_timer: 2 };
    delete story.observations;
    delete story.milestones;
    story.last_insight = null;
    const screen = render(<PracticeStory story={story} stageName="Teal" timezone="UTC" />);
    expect(screen.queryByTestId('practice-story-section-modes')).toBeNull();
    expect(screen.queryByTestId('practice-story-section-observations')).toBeNull();
    expect(screen.queryByTestId('practice-story-section-milestones')).toBeNull();
    expect(screen.queryByText('Last insight')).toBeNull();
    expect(screen.getAllByRole('image')).toHaveLength(3);
  });
  it('ignores unknown milestone kinds without guessing their units', () => {
    const story = storyFixture();
    story.milestones = [{ kind: 'future_kind', value: 42, reached_on: '2026-10-19' }];
    const screen = render(<PracticeStory story={story} stageName="Teal" timezone="UTC" />);
    expect(screen.queryByText(/future_kind/)).toBeNull();
    expect(screen.queryByTestId('practice-story-section-milestones')).toBeNull();
  });
  it.each([
    [0, '0 min'],
    [0.25, '<1 min'],
    [59.8, '1 h 0 m'],
    [65, '1 h 5 m'],
    [119.8, '2 h 0 m'],
  ])('formats %s minutes without 60-minute remainders', (minutes, label) => {
    expect(formatPracticeMinutes(Number(minutes))).toBe(label);
  });
  it('formats calendar keys as calendar dates', () => {
    expect(formatCalendarDate('2026-10-19')).toBe('Oct 19, 2026');
  });
});
