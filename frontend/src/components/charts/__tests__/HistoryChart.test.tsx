import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Circle, Text as SvgText } from 'react-native-svg';

import { HistoryChart } from '../HistoryChart';

const points = [
  { label: '5 Jan 2026', value: 0 },
  { label: '6 Jan 2026', value: 2.5 },
  { label: '7 Jan 2026', value: 1 },
];

describe('inspectable chart history', () => {
  it('labels its measure and dates, and reveals exact values by tap and accessible adjustment', () => {
    const tree = render(
      <HistoryChart
        testID="history"
        points={points}
        measure="Pages completed"
        summary="Pages over time."
        width={320}
      />,
    );
    expect(tree.getByText('Pages completed')).toBeTruthy();
    expect(tree.getByText('Date')).toBeTruthy();
    const plot = tree.getByTestId('history-inspect');
    fireEvent.press(plot, { nativeEvent: { locationX: 180 } });
    expect(tree.getByTestId('history-value')).toHaveTextContent('6 Jan 2026 · 2.5 pages completed');
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(tree.getByTestId('history-value')).toHaveTextContent('7 Jan 2026 · 1 pages completed');
    fireEvent.press(tree.getByRole('button', { name: 'Show as table' }));
    expect(tree.getAllByText('Pages completed')).toHaveLength(3);
    expect(tree.getByText('2.5')).toBeTruthy();
  });

  it('shows a negative domain and an honest signed value', () => {
    const tree = render(
      <HistoryChart
        testID="energy"
        points={[
          { label: 'Week 1', value: -8 },
          { label: 'Week 2', value: 3 },
        ]}
        measure="Net energy"
        variant="columns"
        summary="Signed energy."
        width={320}
      />,
    );
    expect(tree.UNSAFE_getAllByType(SvgText).some((node) => node.props.children === '-8')).toBe(
      true,
    );
    fireEvent.press(tree.getByTestId('energy-inspect'), { nativeEvent: { locationX: 50 } });
    expect(tree.getByTestId('energy-value')).toHaveTextContent('Week 1 · -8 net energy');
  });
});

it('keeps a first-day point aligned with the inspection cursor', () => {
  const tree = render(
    <HistoryChart
      testID="first-day"
      points={[{ label: '5 Jan 2026', value: 2 }]}
      measure="Pages logged"
      summary="The first day."
      width={320}
    />,
  );
  fireEvent.press(tree.getByTestId('first-day-inspect'), { nativeEvent: { locationX: 100 } });
  const [point, cursor] = tree.UNSAFE_getAllByType(Circle);
  expect(point?.props.cx).toBe(cursor?.props.cx);
  expect(point?.props.cy).toBe(cursor?.props.cy);
});
