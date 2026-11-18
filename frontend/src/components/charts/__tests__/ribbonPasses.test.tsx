import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';

import { markerLanes, weekCenter } from '../geometry';
import { Ribbon, type RibbonMarker } from '../Ribbon';

import { accent, chartLayout, SPACING, STAGE_COLORS, surface } from '@/design/tokens';

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

  it('stops the you-are-here line at the track and haloes it so it reads on any stage', () => {
    const view = render(
      <Ribbon blocks={blocks} markers={markers} currentWeek={8} width={NARROW} summary="Pass 4." />,
    );
    const here = view.getByTestId('ribbon-here', { includeHiddenElements: true });
    expect(Number(here.props.y2)).toBe(chartLayout.ribbonHeight);
    const halo = view
      .UNSAFE_getAllByType(Line)
      .find((node) => node.props.testID === 'ribbon-here-halo')!;
    expect(halo.props.x1).toBe(here.props.x1);
    expect(halo.props.y2).toBe(here.props.y2);
    expect(halo.props.stroke).toBe(surface.canvas);
    expect(Number(halo.props.strokeWidth)).toBe(chartLayout.haloWidth);
    expect(chartLayout.haloWidth).toBeGreaterThan(chartLayout.lineWidth);
  });

  it('keeps the plain arc’s you-are-here line as it was', () => {
    const view = render(<Ribbon blocks={blocks} currentWeek={8} width={360} summary="Arc." />);
    const here = view.getByTestId('ribbon-here', { includeHiddenElements: true });
    expect(Number(here.props.y2)).toBe(chartLayout.ribbonHeight + chartLayout.plotInset);
    expect(view.queryByTestId('ribbon-here-halo', { includeHiddenElements: true })).toBeNull();
  });

  it('starts a pass row’s label, readout and caption on the track’s first pixel', () => {
    const crowd = Array.from({ length: 4 }, (_, index) => ({
      week: 8,
      number: index + 1,
      label: `Habit ${index + 1} · Habit`,
      unlocked: '20 Jul',
    }));
    const view = render(
      <Ribbon
        testID="pass"
        title="Pass 1 · began 5 Jan"
        blocks={blocks}
        drawnWeeks={21}
        markers={crowd}
        width={NARROW}
        summary="Pass 1."
      />,
    );
    const header = StyleSheet.flatten(view.getByTestId('pass-header').props.style);
    expect(header.paddingLeft).toBe(chartLayout.plotInset);
    const notes = StyleSheet.flatten(view.getByTestId('pass-notes').props.style);
    expect(notes.paddingLeft).toBe(chartLayout.plotInset);
    // The readout and the overflow caption keep the frame's rhythm, apart and below the badges.
    expect(notes.gap).toBe(SPACING.sm);
    expect(notes.marginTop).toBe(SPACING.sm);
  });

  it('leaves the plain arc’s header where it was', () => {
    const view = render(<Ribbon testID="arc" title="Week 8" blocks={blocks} summary="Arc." />);
    expect(view.queryByTestId('arc-header')).toBeNull();
    const row = StyleSheet.flatten(view.getByText('Week 8').parent?.parent?.props.style);
    expect(row.paddingLeft).toBeUndefined();
    expect(row.flexDirection).toBe('row');
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
    // Hover and touch cannot reach a marker with no badge; the caption says what can.
    expect(
      within(view.getByTestId('pass')).getByText(
        '2 more in week 8: use the arrow keys or the table.',
      ),
    ).toBeTruthy();
    expect(view.UNSAFE_getAllByType(SvgText)).toHaveLength(chartLayout.markerLanes);
    fireEvent(view.getByTestId('pass-inspect'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    for (let step = 0; step < crowd.length; step += 1)
      fireEvent(view.getByTestId('pass-inspect'), 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
    expect(view.getByTestId('pass-value')).toHaveTextContent(/^Habit 5 · Habit/);
  });
});

describe('a pass ribbon on the web', () => {
  const Platform = require('react-native').Platform as { OS: string };
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  const renderWeb = () =>
    render(
      <Ribbon testID="pass" blocks={blocks} markers={markers} width={NARROW} summary="Pass 4." />,
    );
  const key = (view: ReturnType<typeof render>, name: string) => {
    const event = { key: name, preventDefault: jest.fn() };
    fireEvent(view.getByTestId('pass-inspect'), 'keyDown', event);
    return event.preventDefault;
  };
  const readout = (view: ReturnType<typeof render>) =>
    view.getByTestId('pass-value').props.children as string;

  it('walks the markers with the arrow keys, Home and End, clamped at both ends', () => {
    const view = renderWeb();
    expect(key(view, 'End')).toHaveBeenCalled();
    expect(readout(view)).toMatch(/^Habit 5 · Meditation/);
    key(view, 'ArrowRight');
    expect(readout(view)).toMatch(/^Habit 5 · Meditation/);
    key(view, 'ArrowLeft');
    expect(readout(view)).toMatch(/^Habit 2 · Evening walk/);
    key(view, 'Home');
    expect(readout(view)).toMatch(/^Habit 1 · Morning pages/);
    key(view, 'ArrowLeft');
    expect(readout(view)).toMatch(/^Habit 1 · Morning pages/);
    key(view, 'ArrowRight');
    expect(readout(view)).toMatch(/^Habit 2 · Evening walk/);
  });

  it('leaves every other key to the page', () => {
    const view = renderWeb();
    expect(key(view, 'Tab')).not.toHaveBeenCalled();
    expect(view.queryByTestId('pass-value')).toBeNull();
  });

  it('reads the badge under the pointer on hover', () => {
    const view = renderWeb();
    const plot = NARROW - 2 * chartLayout.plotInset;
    const left = 40;
    const top = 100;
    const lane = (index: number) => Number(markerNode(view, index).props.cy);
    const hover = (x: number, y: number) =>
      fireEvent(view.getByTestId('pass-inspect'), 'mouseMove', {
        clientX: left + x,
        clientY: top + y,
        currentTarget: { getBoundingClientRect: () => ({ left, top }) },
      });
    hover(chartLayout.plotInset + weekCenter(8, ARC_WEEKS, plot), lane(2));
    expect(readout(view)).toMatch(/^Habit 5 · Meditation/);
    hover(chartLayout.plotInset + weekCenter(1, ARC_WEEKS, plot), lane(1));
    expect(readout(view)).toMatch(/^Habit 2 · Evening walk/);
    hover(Number.NaN, lane(0));
    expect(readout(view)).toMatch(/^Habit 2 · Evening walk/);
  });
});
