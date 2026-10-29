import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { CalendarDays } from 'lucide-react-native';
import React from 'react';
import { Circle, Text as SvgText } from 'react-native-svg';

import { HistoryChart } from '../HistoryChart';

const points = [
  { label: '5 Jan 2026', value: 0 },
  { label: '6 Jan 2026', value: 2.5 },
  { label: '7 Jan 2026', value: 1 },
];

describe('a chart door', () => {
  it('opens elsewhere from a named glyph before the table toggle, and is absent unasked', () => {
    const onPress = jest.fn();
    const door = { label: 'Story', hint: 'Opens the story of Pages', icon: CalendarDays, onPress };
    const base = { points, measure: 'Pages', summary: 'Pages over time.', width: 320 };
    const tree = render(<HistoryChart {...base} door={door} />);
    const buttons = tree.getAllByRole('button').map((button) => button.props.accessibilityLabel);
    expect(buttons.indexOf('Story')).toBeLessThan(buttons.indexOf('Show as table'));
    const glyph = tree.getByRole('button', { name: 'Story' });
    expect(glyph.props.accessibilityHint).toBe('Opens the story of Pages');
    fireEvent.press(glyph);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(render(<HistoryChart {...base} />).queryByRole('button', { name: 'Story' })).toBeNull();
  });
});

describe('inspectable chart history', () => {
  it('heads with its measure, reads the latest point, and inspects by tap and adjustment', () => {
    const tree = render(
      <HistoryChart
        testID="history"
        points={points}
        measure="Pages completed"
        unit="pages"
        aside="1 pages"
        summary="Pages over time."
        width={320}
      />,
    );
    expect(tree.getByText('Pages completed')).toBeTruthy();
    expect(tree.getByText('1 pages')).toBeTruthy();
    expect(tree.queryByText('Date')).toBeNull();
    expect(tree.getByTestId('history-value')).toHaveTextContent('7 Jan 2026 · 1 pages');
    const plot = tree.getByTestId('history-inspect');
    fireEvent.press(plot, { nativeEvent: { locationX: 180 } });
    expect(tree.getByTestId('history-value')).toHaveTextContent('6 Jan 2026 · 2.5 pages');
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(tree.getByTestId('history-value')).toHaveTextContent('7 Jan 2026 · 1 pages');
    fireEvent.press(tree.getByRole('button', { name: 'Show as table' }));
    expect(tree.getAllByText('Pages completed')).toHaveLength(4);
    expect(tree.getByText('2.5 pages')).toBeTruthy();
  });

  it('writes a fractional maximum readably, so the axis never clips it to 285714', () => {
    const tree = render(
      <HistoryChart
        testID="lifting"
        points={[
          { label: '5 Jan 2026', value: 0 },
          { label: '6 Jan 2026', value: 9 / 7 },
        ]}
        measure="Lifting"
        summary="Sets."
        width={320}
      />,
    );
    const labels = tree.UNSAFE_getAllByType(SvgText).map((node) => node.props.children);
    expect(labels).toContain('1.3');
    expect(labels.some((label) => String(label).includes('285714'))).toBe(false);
  });

  it('draws a compact sparkline without axis or ticks, and reads only when asked', () => {
    const tree = render(
      <HistoryChart
        testID="spark"
        points={points}
        measure="Pages"
        summary="Pages."
        width={320}
        compact
      />,
    );
    expect(tree.UNSAFE_queryAllByType(SvgText)).toHaveLength(0);
    expect(tree.queryByText('5 Jan 2026')).toBeNull();
    expect(tree.queryByTestId('spark-value')).toBeNull();
    fireEvent.press(tree.getByTestId('spark-inspect'), { nativeEvent: { locationX: 0 } });
    expect(tree.getByTestId('spark-value')).toHaveTextContent('5 Jan 2026 · 0');
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
    expect(tree.getByTestId('energy-value')).toHaveTextContent('Week 1 · -8');
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
