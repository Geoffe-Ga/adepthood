import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Circle, G, Text as SvgText } from 'react-native-svg';

import { DotStrip, pointTableRows } from '../DotStrip';

import { chartLayout, ink } from '@/design/tokens';

const points = [
  { label: 'Oct 19', value: 0.25, hollow: true },
  { label: 'Oct 20', value: 45, hollow: false },
];
describe('DotStrip optional y ticks', () => {
  it.each([160, 320])('preserves marks, rings and scales within %s pixels', (width) => {
    const screen = render(
      <DotStrip
        points={points}
        width={width}
        height={160}
        summary="Sits in minutes"
        yTicks={[0, 45]}
        ask={{ value: 45, label: 'Teal asks 45 min' }}
      />,
    );
    const ticks = screen.UNSAFE_getAllByType(SvgText);
    expect(ticks.map((node) => node.props.children)).toEqual(['0', '45']);
    expect(ticks.every((node) => node.props.fill === ink.muted)).toBe(true);
    const plotGroup = screen
      .UNSAFE_getAllByType(G)
      .find((node) => node.props.testID === 'dot-strip-marks')!;
    for (const circle of screen.UNSAFE_getAllByType(Circle)) {
      expect(
        Number(plotGroup.props.x) + Number(circle.props.cx) - Number(circle.props.r),
      ).toBeGreaterThanOrEqual(0);
      expect(
        Number(plotGroup.props.x) + Number(circle.props.cx) + Number(circle.props.r),
      ).toBeLessThanOrEqual(width);
      expect(
        Number(plotGroup.props.y) + Number(circle.props.cy) - Number(circle.props.r),
      ).toBeGreaterThanOrEqual(0);
      expect(
        Number(plotGroup.props.y) + Number(circle.props.cy) + Number(circle.props.r),
      ).toBeLessThanOrEqual(160);
    }
    expect(screen.getByTestId('dot-strip-point-0', { includeHiddenElements: true }).props.r).toBe(
      chartLayout.dotRadius,
    );
    expect(pointTableRows(points)[0]?.values).toEqual([0.25, 'Partial']);
    fireEvent.press(screen.getByRole('button', { name: 'Show as table' }));
    expect(screen.getByText('0.25')).toBeTruthy();
  });
  it('keeps the original plot inset when no axis was requested', () => {
    const screen = render(<DotStrip points={points} width={160} summary="Sits" />);
    expect(screen.UNSAFE_queryAllByType(SvgText)).toHaveLength(0);
    expect(
      screen.UNSAFE_getAllByType(G).find((node) => node.props.testID === 'dot-strip-marks')?.props
        .x,
    ).toBe(chartLayout.plotInset);
  });
});
