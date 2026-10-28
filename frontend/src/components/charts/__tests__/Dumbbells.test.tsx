import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Circle, Line } from 'react-native-svg';

import { Dumbbells, dumbbellTableRows } from '../index';

import { accent, chart } from '@/design/tokens';

const rows = [
  { label: 'Beige', from: 0.4, to: 0.7 },
  { label: 'Purple', from: null, to: 0.5 },
];
const percent = (value: number) => `${Math.round(value * 100)}%`;

describe('Dumbbells', () => {
  it('joins the earlier and later pass, and draws a lone dot without an earlier one', () => {
    const view = render(
      <Dumbbells
        rows={rows}
        fromLabel="Cycle 1"
        toLabel="Cycle 2"
        summary="Per stage, cycle 1 to cycle 2."
        width={300}
      />,
    );
    const dots = view.UNSAFE_getAllByType(Circle);
    expect(dots.map((dot) => dot.props.fill)).toEqual([
      chart.tier[0],
      accent.primary,
      accent.primary,
    ]);
    expect(view.UNSAFE_getAllByType(Line)).toHaveLength(1);
    expect(dots[0]!.props.cx).toBeLessThan(dots[1]!.props.cx);
    expect(view.getByText('Cycle 1')).toBeTruthy();
    expect(view.getByLabelText('Per stage, cycle 1 to cycle 2.')).toBeTruthy();
  });

  it('keeps a table twin in its own units', () => {
    expect(dumbbellTableRows(rows, percent)).toEqual([
      { label: 'Beige', values: ['40%', '70%'] },
      { label: 'Purple', values: ['—', '50%'] },
    ]);
    expect(dumbbellTableRows(rows)[0]!.values).toEqual(['0.4', '0.7']);
    const view = render(
      <Dumbbells
        rows={rows}
        fromLabel="Before"
        toLabel="Now"
        format={percent}
        max={0}
        summary="s"
      />,
    );
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    expect(view.getByText('70%')).toBeTruthy();
  });
});
