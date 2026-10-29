/* global describe, it, expect */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import Svg, { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';

import { ChartTable, Columns, DotStrip, HBars, HeatGrid, Ribbon, Wave } from '../index';

import { accent, chart, chartLayout, ink, STAGE_COLORS } from '@/design/tokens';

const summary = 'A factual description of these figures.';

describe('chart variants and accessible detail', () => {
  it('clamps an explicit width to a narrower measured container without shrinking markers', () => {
    const view = render(
      <DotStrip
        testID="clamped"
        width={640}
        points={[{ label: 'A sit', value: 20 }]}
        summary={summary}
      />,
    );
    fireEvent(view.getByTestId('clamped'), 'layout', {
      nativeEvent: { layout: { width: 320, height: 160, x: 0, y: 0 } },
    });
    expect(view.UNSAFE_getAllByType(Svg).at(-1)!.props.viewBox).toBe('0 0 320 160');
    expect(view.UNSAFE_getAllByType(Circle)[1]!.props.r).toBeGreaterThanOrEqual(4);
  });
  it.each([
    <Columns key="columns" columns={[]} summary={summary} />,
    <DotStrip key="dots" points={[]} summary={summary} />,
    <HBars key="bars" bars={[]} summary={summary} />,
    <HeatGrid key="heat" weeks={[]} rowLabels={[]} summary={summary} />,
    <Ribbon key="ribbon" blocks={[]} summary={summary} />,
    <Wave key="wave" points={[]} summary={summary} />,
  ])('keeps empty figures readable as a table (%#)', (element) => {
    const view = render(element);
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    expect(view.getByText('No entries yet.')).toBeTruthy();
  });

  it('supports a labelled weekday by time-of-day matrix at 320px', () => {
    const view = render(
      <HeatGrid
        weeks={[
          [{ label: 'Mon dawn', level: 0 }],
          [{ label: 'Mon day', level: 1 }],
          [{ label: 'Mon dusk', level: 2 }],
          [{ label: 'Mon night', level: 3 }],
        ]}
        rowLabels={['M']}
        columnLabels={['Dawn', 'Day', 'Dusk', 'Night']}
        markers={[{ columnIndex: 0, color: STAGE_COLORS.Beige!, label: 'Grounding' }]}
        summary={summary}
        width={320}
      />,
    );
    expect(view.getByText('Night')).toBeTruthy();
    expect(view.getByText('Grounding')).toBeTruthy();
    const cells = view
      .UNSAFE_getAllByType(Rect)
      .filter((node) => typeof node.props.testID === 'string');
    expect(cells).toHaveLength(4);
    expect(cells[3]!.props.x + cells[3]!.props.width).toBeLessThanOrEqual(320);
    expect(cells.map((node) => node.props.fill)).toEqual([chart.heat[0], ...chart.tier]);
    for (const node of view.UNSAFE_getAllByType(SvgText))
      expect(Object.values(ink)).toContain(node.props.fill);
  });

  it('measures the parent and only emphasizes the requested columns', () => {
    const view = render(
      <Columns
        testID="measured"
        columns={[
          { label: 'Rest', segments: [0, 1], emphasis: false },
          { label: 'Return', segments: [2] },
        ]}
        seriesColors={[]}
        ask={{ value: 2, label: 'Ask' }}
        max={4}
        min={0}
        height={100}
        summary={summary}
      />,
    );
    fireEvent(view.getByTestId('measured'), 'layout', {
      nativeEvent: { layout: { width: 320, height: 100, x: 0, y: 0 } },
    });
    expect(view.UNSAFE_getAllByType(Svg).at(-1)!.props.viewBox).toBe('0 0 320 100');
    expect(view.UNSAFE_getAllByType(G).some((node) => node.props.opacity === 0.5)).toBe(true);
    expect(view.getByText('Ask')).toBeTruthy();
    const plot = view.UNSAFE_getAllByType(Svg).at(-1)!;
    expect(
      plot
        .findAllByType(Path)
        .every((node: { props: { fill?: string } }) => node.props.fill === chart.tier[0]),
    ).toBe(true);
  });

  it('keeps full sits filled and the strongest time-of-day bar emphasized', () => {
    const dots = render(
      <DotStrip
        points={[
          { label: 'One', value: 5, hollow: false },
          { label: 'Two', value: 10 },
        ]}
        max={20}
        summary={summary}
      />,
    );
    expect(
      dots
        .UNSAFE_getAllByType(Circle)
        .filter((node) => node.props.testID)
        .every((node) => node.props.fill === accent.primary),
    ).toBe(true);
    dots.unmount();
    const bars = render(
      <HBars
        bars={[
          { label: 'Dawn', value: 4 },
          { label: 'Dusk', value: 2 },
        ]}
        max={8}
        summary={summary}
      />,
    );
    const marks = bars.UNSAFE_getAllByType(Rect);
    expect(marks.map((node) => node.props.fill)).toEqual([accent.primary, chart.dim]);
    expect(marks[0]!.props.width).toBe(marks[1]!.props.width * 2);
    for (const node of bars.UNSAFE_getAllByType(Text))
      expect(Object.values(ink)).toContain(StyleSheet.flatten(node.props.style).color);
  });

  it('draws a quiet wave wash, endpoint, month ticks and labelled stage swatches', () => {
    const view = render(
      <Wave
        points={[
          { label: '2026-09-01', value: 0.25 },
          { label: '2026-10-01', value: 0.5 },
        ]}
        max={1}
        monthTicks={[
          { index: 0, label: 'Sep' },
          { index: 1, label: 'Oct' },
        ]}
        swatches={[{ index: 0, color: STAGE_COLORS.Beige!, label: 'Grounding' }]}
        width={320}
        height={160}
        summary={summary}
      />,
    );
    expect(view.getByText('Grounding')).toBeTruthy();
    const paths = view.UNSAFE_getAllByType(Path);
    expect(paths.find((node) => node.props.testID === 'wave-area')!.props.fillOpacity).toBe(0.1);
    expect(paths.find((node) => node.props.testID === 'wave-line')!.props.strokeWidth).toBe(2);
    expect(view.UNSAFE_getAllByType(SvgText).map((node) => node.props.children)).toEqual([
      'Sep',
      'Oct',
    ]);
    expect(view.UNSAFE_getAllByType(Circle)[0]!.props.r).toBe(chartLayout.dotRadius);
  });

  it('keeps both ribbons labelled and exposes point markers and the current week in the table', () => {
    const view = render(
      <Ribbon
        blocks={[{ label: 'Grounding', weeks: 3, color: STAGE_COLORS.Beige! }]}
        secondaryBlocks={[{ label: 'Previous Grounding', weeks: 3, color: STAGE_COLORS.Beige! }]}
        markers={[{ week: 0, label: 'Water begins' }]}
        currentWeek={4}
        summary={summary}
      />,
    );
    expect(view.getByText('Previous Grounding')).toBeTruthy();
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    expect(view.getByText('You are here')).toBeTruthy();
    expect(view.getByText('Water begins')).toBeTruthy();
    expect(view.getByText('Week 4')).toBeTruthy();
  });

  it('keeps week-one ribbon markers fully inside the SVG canvas', () => {
    const view = render(
      <Ribbon
        width={320}
        blocks={[{ label: 'Grounding', weeks: 3, color: STAGE_COLORS.Beige! }]}
        markers={[{ week: 1, label: 'A habit begins' }]}
        currentWeek={1}
        summary={summary}
      />,
    );
    const plot = view.UNSAFE_getAllByType(G).find((node) => typeof node.props.x === 'number');
    const marker = view.UNSAFE_getAllByType(Circle)[0]!;
    const x = Number(plot?.props.x ?? 0) + Number(marker.props.cx);
    expect(x - Number(marker.props.r)).toBeGreaterThanOrEqual(0);
    expect(x + Number(marker.props.r)).toBeLessThanOrEqual(320);
  });

  it('uses tabular ink figures in tables and supports unheaded rows', () => {
    const view = render(<ChartTable rows={[{ label: 'A', values: [1] }]} />);
    const number = view.getByText('1');
    expect(StyleSheet.flatten(number.props.style).fontVariant).toEqual(['tabular-nums']);
    for (const node of view.UNSAFE_getAllByType(Text))
      expect(Object.values(ink)).toContain(StyleSheet.flatten(node.props.style).color);
  });
});
