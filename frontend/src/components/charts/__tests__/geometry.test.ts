/* global describe, it, expect */
import {
  columnDomain,
  columnGeometry,
  columnPath,
  domainY,
  dotGeometry,
  positive,
  ribbonGeometry,
  scaled,
  scaleMaximum,
} from '../geometry';
import {
  barTableRows,
  columnTableRows,
  heatTableRows,
  pointTableRows,
  ribbonTableRows,
} from '../index';

describe('chart scales preserve the supplied figures', () => {
  it('honors a positive fractional maximum instead of silently rounding it up', () => {
    expect(scaleMaximum([0.25, 0.5], 0.5)).toBe(0.5);
    expect(scaled(0.25, scaleMaximum([0.25, 0.5], 0.5), 100)).toBe(50);
  });
  it('places positive and negative net energy on opposite sides of zero', () => {
    const columns = [
      { label: 'Return', segments: [5, 5] },
      { label: 'Cost', segments: [-5, -5] },
    ];
    const domain = columnDomain(columns);
    expect(domain).toEqual({ min: -10, max: 10 });
    expect(domainY(0, domain.min, domain.max, 100)).toBe(50);
    const marks = columnGeometry(columns, 100, 100, domain.max, domain.min);
    expect(marks[0]![0]!).toMatchObject({ y: 25, height: 25 });
    expect(marks[1]![0]!).toMatchObject({ y: 50, height: 25, negative: true });
    expect(marks[1]![1]!.y - (marks[1]![0]!.y + marks[1]![0]!.height)).toBe(2);
    expect(columnPath(marks[1]![0]!)).toContain('M 63 50 V 71 Q 63 75');
    expect(columnDomain([{ label: 'Only costs', segments: [-5] }])).toEqual({ min: -5, max: 0 });
    expect(columnDomain([], 2, 10, -10)).toEqual({ min: -10, max: 10 });
    expect(columnDomain([])).toEqual({ min: 0, max: 1 });
  });

  it('keeps empty, zero, non-finite and narrow series finite', () => {
    expect(columnGeometry([], 0, 0, 1)).toEqual([]);
    expect(
      columnGeometry([{ label: 'Quiet', segments: [Number.NaN, 0] }], 1, 100, 1)[0]![0]!.height,
    ).toBe(0);
    expect(positive(Number.NaN)).toBe(0);
    expect(positive(-1)).toBe(0);
    expect(scaled(20, 10, 100)).toBe(100);
    expect(scaleMaximum([], 0)).toBe(1);
    expect(scaleMaximum([5, 10])).toBe(10);
    expect(dotGeometry([{ label: 'One', value: 1 }], 100, 100, 2)).toEqual([{ x: 50, y: 50 }]);
    expect(dotGeometry([], 100, 100, 1)).toEqual([]);
    expect(ribbonGeometry([], 100)).toEqual([]);
    expect(ribbonGeometry([{ label: 'No duration', weeks: -1, color: 'unused' }], 100)).toEqual([
      { x: 0, width: 0 },
    ]);
  });

  it('table twins exactly preserve each series, including quiet and partial states', () => {
    expect(
      columnTableRows([
        { label: 'W1', segments: [2, 3, 1], quiet: 1 },
        { label: 'W2', segments: [4] },
      ]),
    ).toEqual([
      { label: 'W1', values: [2, 3, 1, 1] },
      { label: 'W2', values: [4] },
    ]);
    expect(
      pointTableRows([
        { label: 'Partial sit', value: 12, hollow: true },
        { label: 'Full sit', value: 20, hollow: false },
        { label: 'Rhythm', value: 0.5 },
        { label: 'Custom', value: 2, stateLabel: 'Logged' },
      ]),
    ).toEqual([
      { label: 'Partial sit', values: [12, 'Partial'] },
      { label: 'Full sit', values: [20, 'Completed'] },
      { label: 'Rhythm', values: [0.5] },
      { label: 'Custom', values: [2, 'Logged'] },
    ]);
    expect(
      heatTableRows([
        [
          { label: 'Mon', level: 0, hollow: true },
          { label: 'Tue', level: 3 },
        ],
      ]),
    ).toEqual([
      { label: 'Mon', values: [0, 'Logged, under Low'] },
      { label: 'Tue', values: [3] },
    ]);
    expect(barTableRows([{ label: 'Dawn', value: 12 }])).toEqual([{ label: 'Dawn', values: [12] }]);
    expect(ribbonTableRows([{ label: 'Stage', weeks: 3, color: 'unused' }])).toEqual([
      { label: 'Stage', values: ['Weeks 1–3'] },
    ]);
  });
});
