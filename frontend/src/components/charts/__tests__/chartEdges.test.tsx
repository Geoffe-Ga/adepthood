/* global describe, it, expect */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Circle, Rect, Text as SvgText } from 'react-native-svg';

import { axisTickLabels, columnGeometry } from '../geometry';
import { ChartTable, DotStrip, HBars, HeatGrid, Ribbon, Wave, pointTableRows } from '../index';

import { chartLayout, STAGE_COLORS } from '@/design/tokens';

const summary = 'The same facts in a chart and a table.';
const points = Array.from({ length: 253 }, (_, index) => ({
  label: `Day ${index + 1}`,
  value: index / 253,
}));
const bounds = (node: { props: Record<string, unknown> }, x = 0, y = 0) => ({
  left: x + Number(node.props.x),
  right: x + Number(node.props.x) + Number(node.props.width),
  top: y + Number(node.props.y),
  bottom: y + Number(node.props.y) + Number(node.props.height),
});

describe('bounded chart geometry', () => {
  it('keeps one scale across bars whose value labels have different widths', () => {
    const view = render(
      <HBars
        bars={[
          { label: 'Dawn', value: 10000 },
          { label: 'Dusk', value: 5000 },
        ]}
        width={320}
        summary={summary}
      />,
    );
    const tips = view.UNSAFE_getAllByType(Text);
    fireEvent(
      tips.find((node) => node.props.children === '10000')!,
      'layout',
      { nativeEvent: { layout: { width: 50, height: 20, x: 0, y: 0 } } },
    );
    fireEvent(
      tips.find((node) => node.props.children === '5000')!,
      'layout',
      { nativeEvent: { layout: { width: 40, height: 20, x: 0, y: 0 } } },
    );
    fireEvent(
      tips.find((node) => node.props.children === '10000')!,
      'layout',
      { nativeEvent: { layout: { width: 50, height: 20, x: 0, y: 0 } } },
    );
    const marks = view.UNSAFE_getAllByType(Rect);
    expect(Number(marks[0]!.props.width)).toBe(Number(marks[1]!.props.width) * 2);
  });
  it('bounds and thins near-left/right month labels without losing the raw series', () => {
    const ticks = [
      { index: 0, label: 'Mar' },
      { index: 2, label: 'Apr' },
      { index: 32, label: 'May' },
      { index: 63, label: 'Jun' },
      { index: 252, label: 'Dec' },
    ];
    const labels = axisTickLabels(ticks, points.length, 304);
    expect(labels.length).toBeLessThan(ticks.length);
    expect(labels.length).toBeGreaterThan(1);
    labels.forEach((label, index) => {
      expect(label.left).toBeGreaterThanOrEqual(0);
      expect(label.left + label.width).toBeLessThanOrEqual(304);
      if (index > 0)
        expect(label.left).toBeGreaterThanOrEqual(
          labels[index - 1]!.left + labels[index - 1]!.width + chartLayout.gap,
        );
    });
    expect(labels.map((label) => label.anchor)).toEqual(['start', 'middle', 'end']);
    const view = render(<Wave points={points} monthTicks={ticks} width={320} summary={summary} />);
    expect(view.UNSAFE_getAllByType(SvgText).map((node) => node.props.children)).toEqual(
      labels.map((label) => label.label),
    );
    expect(pointTableRows(points)).toHaveLength(253);
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    expect(view.getByText('Day 253')).toBeTruthy();
  });

  it('fits a lone month and a long axis label inside narrow plots', () => {
    const single = axisTickLabels([{ index: 0, label: 'Oct' }], 1, 304);
    expect(single[0]!.x).toBe(152);
    const long = axisTickLabels([{ index: 0, label: 'A long month description' }], 1, 52);
    expect(long[0]!.width).toBeLessThanOrEqual(52);
    expect(long[0]!.label).toContain('…');
    expect(axisTickLabels([{ index: 0, label: 'Oct' }], 1, 1)).toEqual([]);
  });

  it.each([100000, 10000.123456789, 0.12345678901234568])(
    'lays out the full value %s at its bar tip inside320px',
    (value) => {
      const view = render(
        <HBars bars={[{ label: 'Dawn', value }]} width={320} max={value} summary={summary} />,
      );
      const tip = view
        .UNSAFE_getAllByType(Text)
        .find((node) => node.props.children === String(value));
      expect(tip).toBeTruthy();
      fireEvent(tip!, 'layout', {
        nativeEvent: { layout: { width: 130, height: 20, x: 0, y: 0 } },
      });
      const mark = view.UNSAFE_getByType(Rect);
      expect(Number(mark.props.width) + chartLayout.plotInset + 130).toBeLessThanOrEqual(320);
      expect(tip!.props.numberOfLines).toBeUndefined();
    },
  );

  it('re-reserves a growing value and a narrower parent before measuring again', () => {
    const view = render(
      <HBars bars={[{ label: 'Dawn', value: 1 }]} width={320} summary={summary} />,
    );
    const value = view.UNSAFE_getAllByType(Text).find((node) => node.props.children === '1')!;
    fireEvent(value, 'layout', { nativeEvent: { layout: { width: 7, height: 20, x: 0, y: 0 } } });
    view.rerender(
      <HBars bars={[{ label: 'Dawn', value: 100000.123456 }]} width={160} summary={summary} />,
    );
    expect(Number(view.UNSAFE_getByType(Rect).props.width)).toBeLessThanOrEqual(
      160 - chartLayout.plotInset,
    );
    expect(
      view.UNSAFE_getAllByType(Text).find((node) => node.props.children === '100000.123456'),
    ).toBeTruthy();
  });

  it('keeps full first/last dot rings and ribbon markers inside the canvas', () => {
    const dots = render(
      <DotStrip
        points={[
          { label: 'First', value: 0 },
          { label: 'Last', value: 1 },
        ]}
        width={320}
        max={1}
        summary={summary}
      />,
    );
    const markers = dots.UNSAFE_getAllByType(Circle).filter((node) => node.props.testID);
    for (const marker of markers) {
      const x = Number(marker.props.cx) + chartLayout.plotInset;
      expect(x - Number(marker.props.r) - chartLayout.lineWidth).toBeGreaterThanOrEqual(0);
      expect(x + Number(marker.props.r) + chartLayout.lineWidth).toBeLessThanOrEqual(320);
    }
    dots.unmount();
    const ribbon = render(
      <Ribbon
        blocks={[{ label: 'Grounding', weeks: 36, color: STAGE_COLORS.Beige! }]}
        markers={[
          { week: 1, label: 'First' },
          { week: 37, label: 'Last' },
        ]}
        width={320}
        summary={summary}
      />,
    );
    for (const marker of ribbon.UNSAFE_getAllByType(Circle)) {
      const x = Number(marker.props.cx) + chartLayout.plotInset;
      expect(x - Number(marker.props.r)).toBeGreaterThanOrEqual(0);
      expect(x + Number(marker.props.r)).toBeLessThanOrEqual(320);
    }
  });

  it('keeps dense heat cells and signed column ends inside their plot', () => {
    const weeks = Array.from({ length: 53 }, (_, week) =>
      Array.from({ length: 7 }, (_, day) => ({ label: `${week}-${day}`, level: 3 as const })),
    );
    const heat = render(<HeatGrid weeks={weeks} width={320} height={160} summary={summary} />);
    for (const cell of heat.UNSAFE_getAllByType(Rect)) {
      const box = bounds(cell);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(160);
    }
    const columns = columnGeometry(
      [
        { label: 'First', segments: [10] },
        { label: 'Last', segments: [-10] },
      ],
      320,
      160,
      10,
      -10,
    );
    for (const column of columns.flat()) {
      expect(column.x).toBeGreaterThanOrEqual(0);
      expect(column.x + column.width).toBeLessThanOrEqual(320);
      expect(column.y + column.height).toBeLessThanOrEqual(160);
    }
  });

  it('lets long table labels and cells wrap within the parent', () => {
    const label = 'A very long habit label with a complete description';
    const view = render(<ChartTable rows={[{ label, values: ['10000.1234567890123456789'] }]} />);
    const style = StyleSheet.flatten(view.getByText(label).props.style);
    expect(style.flexShrink).toBe(1);
    expect(style.maxWidth).toBe('100%');
    expect(view.getByText(label).props.numberOfLines).toBeUndefined();
  });
});
