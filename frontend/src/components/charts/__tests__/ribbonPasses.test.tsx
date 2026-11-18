import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import { Circle, Rect, Text as SvgText } from 'react-native-svg';

import { markerLanes, weekCenter } from '../geometry';
import { Ribbon, type RibbonMarker } from '../Ribbon';

import { accent, chartLayout, STAGE_COLORS } from '@/design/tokens';

/** The arc's real shape: four three-week stages, then six of four. */
const WEEKS = [3, 3, 3, 3, 4, 4, 4, 4, 4, 4];
const COLOURS = Object.values(STAGE_COLORS);
const blocks = WEEKS.map((weeks, index) => ({
  label: `Stage ${index + 1}`,
  weeks,
  color: COLOURS[index]!,
}));
const ARC_WEEKS = 36;
const NARROW = 320;
const DIAMETER = 2 * chartLayout.markerRadius;

const markers: RibbonMarker[] = [
  { week: 1, number: 1, hollow: false, label: 'Habit 1 · Morning pages', unlocked: '1 Jun' },
  { week: 1, number: 2, hollow: false, label: 'Habit 2 · Evening walk', unlocked: '1 Jun' },
  {
    week: 8,
    number: 5,
    hollow: true,
    label: 'Habit 5 · Meditation',
    unlocked: '20 Jul',
    note: 'locked now',
  },
];

const rects = (view: ReturnType<typeof render>) =>
  view.UNSAFE_getAllByType(Rect).filter((node) => String(node.props.testID).startsWith('ribbon-'));
const markerNode = (view: ReturnType<typeof render>, index: number) =>
  view.UNSAFE_getAllByType(Circle).find((node) => node.props.testID === `ribbon-marker-${index}`)!;

describe('marker lanes', () => {
  it('places markers on the middle of their week', () => {
    expect(weekCenter(1, ARC_WEEKS, 360)).toBe(5);
    expect(weekCenter(36, ARC_WEEKS, 360)).toBe(355);
    expect(weekCenter(99, ARC_WEEKS, 360)).toBe(360);
    expect(weekCenter(-3, ARC_WEEKS, 360)).toBe(0);
  });

  it('stacks markers that share a week so none overlap at 320 px', () => {
    const layout = markerLanes([8, 8, 9, 20], ARC_WEEKS, NARROW);
    expect(layout.overflow).toEqual([]);
    expect(layout.slots.map((slot) => slot.lane)).toEqual([0, 1, 2, 0]);
    for (const a of layout.slots)
      for (const b of layout.slots)
        if (a !== b && a.lane === b.lane)
          expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(DIAMETER + chartLayout.gap);
    expect(layout.lanes).toBe(3);
  });

  it('counts the markers that do not fit rather than drawing them over each other', () => {
    const layout = markerLanes([8, 8, 8, 8, 8], ARC_WEEKS, NARROW);
    expect(layout.slots).toHaveLength(chartLayout.markerLanes);
    expect(layout.overflow).toEqual([3, 4]);
  });

  it('lays markers out in week order whatever order they arrive in', () => {
    const layout = markerLanes([20, 8], ARC_WEEKS, NARROW);
    expect(layout.slots.map((slot) => slot.index)).toEqual([1, 0]);
  });
});

describe('a pass ribbon', () => {
  it('draws stage colour only as far as a partial pass reached, then an unfilled track', () => {
    const view = render(<Ribbon blocks={blocks} drawnWeeks={21} width={360} summary="Pass 1." />);
    const track = view
      .UNSAFE_getAllByType(Rect)
      .find((node) => node.props.testID === 'ribbon-track');
    expect(track?.props.width).toBe(360 - 2 * chartLayout.plotInset);
    const drawn = rects(view).filter((node) => node.props.testID !== 'ribbon-track');
    expect(drawn).toHaveLength(7);
    const last = drawn.at(-1)!;
    const plot = 360 - 2 * chartLayout.plotInset;
    expect(Number(last.props.x) + Number(last.props.width)).toBeCloseTo((21 / ARC_WEEKS) * plot);
  });

  it('draws a pending pass as the empty track alone', () => {
    const view = render(<Ribbon blocks={blocks} drawnWeeks={0} width={360} summary="Pass 5." />);
    expect(rects(view).map((node) => node.props.testID)).toEqual(['ribbon-track']);
  });

  it('keeps the full ribbon and no track when nothing limits it', () => {
    const view = render(<Ribbon blocks={blocks} width={360} summary="The arc." />);
    expect(rects(view).some((node) => node.props.testID === 'ribbon-track')).toBe(false);
    expect(rects(view)).toHaveLength(10);
  });

  it('numbers each marker and draws a habit locked again as a ring', () => {
    const view = render(
      <Ribbon blocks={blocks} markers={markers} currentWeek={8} width={NARROW} summary="Pass 4." />,
    );
    const numbers = view.UNSAFE_getAllByType(SvgText).map((node) => String(node.props.children));
    expect(numbers).toEqual(['1', '2', '5']);
    expect(markerNode(view, 0).props.fill).toBe(accent.primary);
    expect(markerNode(view, 2).props.fill).toBe('none');
    expect(markerNode(view, 2).props.stroke).toBe(accent.primary);
    expect(markerNode(view, 0).props.cy).not.toBe(markerNode(view, 1).props.cy);
  });

  it('stands the you-are-here line on the middle of its week, over that week’s badges', () => {
    const view = render(
      <Ribbon blocks={blocks} markers={markers} currentWeek={8} width={NARROW} summary="Pass 4." />,
    );
    const here = view.getByTestId('ribbon-here', { includeHiddenElements: true });
    expect(here.props.x1).toBe(markerNode(view, 2).props.cx);
    expect(Number(here.props.y2)).toBeLessThan(
      Number(markerNode(view, 2).props.cy) - chartLayout.markerRadius,
    );
  });

  it('centres the you-are-here line on its week on a pass row with no habits yet', () => {
    const view = render(
      <Ribbon blocks={blocks} drawnWeeks={ARC_WEEKS} currentWeek={8} width={360} summary="Pass." />,
    );
    const here = view.getByTestId('ribbon-here', { includeHiddenElements: true });
    expect(here.props.x1).toBe(weekCenter(8, ARC_WEEKS, 360 - 2 * chartLayout.plotInset));
  });

  it('lists number, name, unlock date, week and lock in the table twin', () => {
    const view = render(
      <Ribbon blocks={blocks} markers={markers} width={NARROW} summary="Pass 4." />,
    );
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    expect(view.getByText('Habit 5 · Meditation')).toBeTruthy();
    expect(view.getByText('Unlocked 20 Jul')).toBeTruthy();
    expect(view.getByText('Week 8')).toBeTruthy();
    expect(view.getByText('Locked now')).toBeTruthy();
    expect(view.getAllByText('Unlocked 1 Jun')).toHaveLength(2);
    const labels = view.UNSAFE_getAllByType(Text).map((node) => String(node.props.children));
    expect(labels.indexOf('Habit 1 · Morning pages')).toBeLessThan(labels.indexOf('Stage 1'));
  });

  it('reaches every marker by touch and by the adjustable actions, and reads it out', () => {
    const view = render(
      <Ribbon testID="pass" blocks={blocks} markers={markers} width={NARROW} summary="Pass 4." />,
    );
    const plot = view.getByTestId('pass-inspect');
    expect(plot.props.accessibilityLabel).toBe('Pass 4.');
    expect(view.queryByTestId('pass-value')).toBeNull();
    const eighth = weekCenter(8, ARC_WEEKS, NARROW - 2 * chartLayout.plotInset);
    fireEvent.press(plot, {
      nativeEvent: {
        locationX: eighth + chartLayout.plotInset,
        locationY: chartLayout.ribbonHeight + chartLayout.markerRadius,
      },
    });
    expect(view.getByTestId('pass-value')).toHaveTextContent(
      'Habit 5 · Meditation · unlocked 20 Jul, week 8, locked now',
    );
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(view.getByTestId('pass-value')).toHaveTextContent(
      'Habit 2 · Evening walk · unlocked 1 Jun, week 1',
    );
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(view.getByTestId('pass-value')).toHaveTextContent(
      'Habit 1 · Morning pages · unlocked 1 Jun, week 1',
    );
    expect(view.getByTestId('pass-inspect').props.accessibilityValue.text).toBe(
      'Habit 1 · Morning pages · unlocked 1 Jun, week 1',
    );
  });

  it('starts keyboard and screen-reader travel at the first marker', () => {
    const view = render(
      <Ribbon testID="pass" blocks={blocks} markers={markers} width={NARROW} summary="Pass 4." />,
    );
    fireEvent(view.getByTestId('pass-inspect'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(view.getByTestId('pass-value')).toHaveTextContent(/^Habit 1 · Morning pages/);
  });

  it('counts the markers that do not fit and sends the reader to the table', () => {
    const crowd = Array.from({ length: 5 }, (_, index) => ({
      week: 8,
      number: index + 1,
      label: `Habit ${index + 1} · Habit`,
      unlocked: '20 Jul',
    }));
    const view = render(
      <Ribbon testID="pass" blocks={blocks} markers={crowd} width={NARROW} summary="Crowded." />,
    );
    expect(
      within(view.getByTestId('pass')).getByText('2 more in week 8, listed in the table.'),
    ).toBeTruthy();
    expect(view.UNSAFE_getAllByType(SvgText)).toHaveLength(chartLayout.markerLanes);
  });
});
