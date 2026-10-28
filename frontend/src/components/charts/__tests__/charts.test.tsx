/* global describe, it, expect */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Circle, Rect } from 'react-native-svg';

import { columnGeometry, dotGeometry, ribbonGeometry } from '../geometry';
import { Columns, DotStrip, HBars, HeatGrid, Ribbon, Wave } from '../index';

import { chart, ink, STAGE_COLORS, surface } from '@/design/tokens';

const summary = 'Your own progress over time.';
const columns = [{ label: 'This week', segments: [2, 3, 1], quiet: 1 }];
const points = [{ label: 'October 1', value: 20, hollow: true }];
const blocks = [{ label: 'Grounding', weeks: 3, color: STAGE_COLORS.Beige! }];

describe('progress chart kit', () => {
  it.each([
    [
      <Columns
        key="columns"
        columns={columns}
        seriesLabels={['Low', 'Clear', 'Stretch']}
        summary={summary}
      />,
      ['2', '3', '1'],
    ],
    [<DotStrip key="dots" points={points} summary={summary} />, ['20']],
    [<HBars key="bars" bars={[{ label: 'Dawn', value: 5 }]} summary={summary} />, ['5']],
    [<HeatGrid key="heat" weeks={[[{ label: 'Monday', level: 2 }]]} summary={summary} />, ['2']],
    [<Ribbon key="ribbon" blocks={blocks} summary={summary} />, ['Weeks 1–3']],
    [<Wave key="wave" points={points} summary={summary} />, ['20']],
  ] as const)('offers the same values as a table with a spoken summary (%#)', (element, values) => {
    const view = render(element);
    expect(view.getByLabelText(summary)).toBeTruthy();
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    for (const value of values) expect(view.getAllByText(value).length).toBeGreaterThan(0);
    fireEvent.press(view.getByRole('button', { name: 'Show chart' }));
    expect(view.getByRole('button', { name: 'Show as table' })).toBeTruthy();
  });

  it('scales half-height columns, keeps a square baseline and gaps the stacks', () => {
    const geometry = columnGeometry(
      [
        { label: 'Half', segments: [5] },
        { label: 'Full', segments: [10] },
      ],
      100,
      100,
      10,
    );
    expect(geometry[0]![0]!.height).toBe(50);
    expect(geometry[1]![0]!.height).toBe(100);
    expect(geometry[0]![0]!.width).toBeLessThanOrEqual(24);
    expect(geometry[0]![0]!.y + geometry[0]![0]!.height).toBe(100);
    const stacks = columnGeometry(columns, 100, 70, 7)[0]!;
    expect(stacks[0]!.y - (stacks[1]!.y + stacks[1]!.height)).toBe(2);
  });

  it('scales dots against the ask and retains hollow markers', () => {
    const geometry = dotGeometry(
      [
        { label: 'Half', value: 5, hollow: true },
        { label: 'Full', value: 10 },
      ],
      100,
      100,
      10,
    );
    expect(geometry[0]!.y).toBe(50);
    expect(geometry[1]!.y).toBe(0);
    const view = render(
      <DotStrip
        points={points}
        summary={summary}
        ask={{ value: 30, label: 'Stage ask · 30 min' }}
      />,
    );
    const dot = view
      .UNSAFE_getAllByType(Circle)
      .find((node) => node.props.testID === 'dot-strip-point-0')!;
    expect(dot.props.fill).toBe(surface.canvas);
    expect(dot.props.r).toBeGreaterThanOrEqual(4);
    const ring = view.UNSAFE_getAllByType(Circle).find((node) => !node.props.testID)!;
    expect(Number(ring.props.r) - Number(dot.props.r) - Number(dot.props.strokeWidth) / 2).toBe(2);
    expect(view.getByText('Stage ask · 30 min')).toBeTruthy();
  });

  it('reveals a heat cell label by press and long press', () => {
    const view = render(
      <HeatGrid
        weeks={[[{ label: 'Monday · 32 oz · under Low', level: 0, hollow: true }]]}
        summary={summary}
      />,
    );
    const cell = view
      .UNSAFE_getAllByType(Rect)
      .find((node) => node.props.testID === 'heat-grid-cell-0-0')!;
    expect(cell.props.fill).toBe('none');
    fireEvent.press(cell);
    expect(view.getByText('Monday · 32 oz · under Low')).toBeTruthy();
    fireEvent(cell, 'longPress');
    expect(view.getByText('Monday · 32 oz · under Low')).toBeTruthy();
  });

  it('sizes ribbon blocks by weeks and labels every stage at narrow widths', () => {
    const twoBlocks = [...blocks, { label: 'Unity', weeks: 6, color: STAGE_COLORS.Ultraviolet! }];
    const geometry = ribbonGeometry(twoBlocks, 300);
    expect(geometry[0]!.width).toBe(100);
    expect(geometry[1]!.width).toBe(200);
    const view = render(
      <Ribbon
        blocks={twoBlocks}
        width={320}
        currentWeek={4}
        markers={[{ week: 2, label: 'Water begins' }]}
        summary={summary}
      />,
    );
    expect(view.getByText('Grounding')).toBeTruthy();
    expect(view.getByText('Unity')).toBeTruthy();
    expect(view.getByText('Water begins')).toBeTruthy();
    expect(view.getByTestId('ribbon-here', { includeHiddenElements: true })).toBeTruthy();
  });

  it('uses ink for every text node, never a series or stage colour', () => {
    const view = render(
      <Columns columns={columns} seriesLabels={['Low', 'Clear', 'Stretch']} summary={summary} />,
    );
    for (const node of view.UNSAFE_getAllByType(Text)) {
      expect(Object.values(ink)).toContain(StyleSheet.flatten(node.props.style).color);
    }
    expect(chart.tier).toHaveLength(3);
  });
});
