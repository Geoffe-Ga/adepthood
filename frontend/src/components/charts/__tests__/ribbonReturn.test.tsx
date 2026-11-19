import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Rect } from 'react-native-svg';

import { weekCenter } from '../geometry';
import { Ribbon } from '../Ribbon';

import { chart, chartLayout } from '@/design/tokens';

/** A five-week Return segment, measured against the 36-week arc (#3746). */
const WEEKS = 5;
const ARC_WEEKS = 36;
const WIDTH = 360;
const PLOT = WIDTH - 2 * chartLayout.plotInset;
const SPAN = (PLOT * WEEKS) / ARC_WEEKS;
const blocks = Array.from({ length: WEEKS }, (_, index) => ({
  label: `Week ${index + 1} · Focus ${index + 1}`,
  weeks: 1,
  color: chart.returnArc,
}));
const notes = ['lived', 'lived', 'this week', 'not begun', 'not begun'];

const rects = (view: ReturnType<typeof render>, id: string) =>
  view.UNSAFE_getAllByType(Rect).filter((node) => String(node.props.testID).startsWith(id));

const segment = (props: Partial<React.ComponentProps<typeof Ribbon>> = {}) =>
  render(
    <Ribbon
      testID="return"
      title="Metta Return · began 3 Aug · week 3 of 5"
      blocks={blocks}
      drawnWeeks={3}
      currentWeek={3}
      scaleWeeks={ARC_WEEKS}
      blockNotes={notes}
      tableHeader="In this Return"
      width={WIDTH}
      summary="Metta Return, began 3 August 2026."
      showKey={false}
      {...props}
    />,
  );

describe('a Return segment on the pass rows’ scale', () => {
  it('keeps a pass row’s week width: five weeks take five thirty-sixths of the plot', () => {
    const view = segment({ drawnWeeks: WEEKS, currentWeek: undefined });
    const drawn = rects(view, 'ribbon-block-').filter(
      (node) => node.props.testID !== 'ribbon-block-focus',
    );
    expect(drawn).toHaveLength(WEEKS);
    const last = drawn.at(-1)!;
    expect(Number(last.props.x) + Number(last.props.width)).toBeCloseTo(SPAN);
    expect(Number(drawn[0]!.props.width)).toBeCloseTo(PLOT / ARC_WEEKS);
  });

  it('draws only the reached weeks, then a dashed track as long as the segment', () => {
    const view = segment({ currentWeek: undefined });
    const [track] = rects(view, 'ribbon-track');
    expect(Number(track!.props.width)).toBeCloseTo(SPAN);
    expect(track!.props.strokeDasharray).toBe(`${chartLayout.trackDash} ${chartLayout.trackDash}`);
    const drawn = rects(view, 'ribbon-block-');
    expect(drawn).toHaveLength(3);
    expect(Number(drawn.at(-1)!.props.x) + Number(drawn.at(-1)!.props.width)).toBeCloseTo(
      (SPAN * 3) / WEEKS,
    );
  });

  it('stands the week line on the middle of the current Return week', () => {
    const view = segment();
    const here = view.getByTestId('ribbon-here', { includeHiddenElements: true });
    expect(here.props.x1).toBeCloseTo(weekCenter(3, WEEKS, SPAN));
  });

  it('ignores a scale shorter than its own weeks', () => {
    const view = segment({ scaleWeeks: 2, drawnWeeks: WEEKS, currentWeek: undefined });
    const last = rects(view, 'ribbon-block-').at(-1)!;
    expect(Number(last.props.x) + Number(last.props.width)).toBeCloseTo(PLOT);
  });
});

describe('reading a Return segment week by week', () => {
  it('is one adjustable control, named by its sentence, that the arrow actions walk', () => {
    const view = segment();
    const plot = view.getByTestId('return-inspect');
    expect(plot.props.accessibilityRole).toBe('adjustable');
    expect(plot.props.accessibilityLabel).toBe('Metta Return, began 3 August 2026.');
    expect(plot.props.accessibilityHint).toMatch(/week/);
    expect(view.queryByTestId('return-value')).toBeNull();
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(view.getByTestId('return-value')).toHaveTextContent('Week 1 · Focus 1 · lived');
    for (let step = 0; step < WEEKS; step += 1)
      fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(view.getByTestId('return-value')).toHaveTextContent('Week 5 · Focus 5 · not begun');
    fireEvent(plot, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(view.getByTestId('return-value')).toHaveTextContent('Week 4 · Focus 4 · not begun');
  });

  it('reads the week under a tap, and the nearest one past the segment’s end', () => {
    const view = segment();
    const plot = view.getByTestId('return-inspect');
    const third = chartLayout.plotInset + (SPAN * 2.5) / WEEKS;
    fireEvent.press(plot, { nativeEvent: { locationX: third, locationY: 4 } });
    expect(view.getByTestId('return-value')).toHaveTextContent('Week 3 · Focus 3 · this week');
    expect(rects(view, 'ribbon-block-focus')).toHaveLength(1);
    fireEvent.press(plot, { nativeEvent: { locationX: PLOT, locationY: 4 } });
    expect(view.getByTestId('return-value')).toHaveTextContent('Week 5 · Focus 5 · not begun');
    fireEvent.press(plot, { nativeEvent: { locationX: Number.NaN, locationY: 4 } });
    expect(view.getByTestId('return-value')).toHaveTextContent('Week 5 · Focus 5 · not begun');
  });

  it('lists every week by its focus and where the arc stands in it, in the table twin', () => {
    const view = segment();
    fireEvent.press(view.getByRole('button', { name: 'Show as table' }));
    expect(view.getByText('Week 3 · Focus 3')).toBeTruthy();
    expect(view.getByText('This week')).toBeTruthy();
    expect(view.getAllByText('Lived')).toHaveLength(2);
    expect(view.getAllByText('Not begun')).toHaveLength(2);
    expect(view.getAllByText('In this Return')).toHaveLength(WEEKS);
    // The block's label already names its week, and "This week" says where you are.
    expect(view.queryByText('Week 3')).toBeNull();
    expect(view.queryByText('You are here')).toBeNull();
  });
});
