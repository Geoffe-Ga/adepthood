/* eslint-env jest */
/* global describe, it, expect */
import React from 'react';
import renderer from 'react-test-renderer';

import { colors } from '../../design/tokens';
import { TierStar, type TierStarTier } from '../TierStar';

// react-test-renderer ships no type definitions in this project, so test
// instances are annotated structurally (matching the pattern in the other
// HabitTile/GoalModal renderer tests) to satisfy ``noImplicitAny``.
interface TestNode {
  props: Record<string, unknown>;
}

type Rendered = ReturnType<typeof renderer.create>;

const findPolygon = (component: Rendered): TestNode =>
  component.root.find((node: TestNode) => typeof node.props.points === 'string');

/** Pull the star Polygon's vertex list out of a rendered TierStar. */
const findStarVertices = (component: Rendered): string[][] =>
  String(findPolygon(component).props.points)
    .trim()
    .split(' ')
    .map((pair) => pair.split(','));

describe('TierStar', () => {
  // A star with N points is drawn as N outer + N inner vertices = 2N total.
  const cases: ReadonlyArray<[TierStarTier, number]> = [
    ['low', 4],
    ['clear', 5],
    ['stretch', 10],
  ];

  it.each(cases)('renders %s as a %d-pointed star', (tier, points) => {
    const component = renderer.create(<TierStar tier={tier} />);
    expect(findStarVertices(component)).toHaveLength(points * 2);
  });

  it('defaults the accessibilityLabel to the spoken tier name', () => {
    const labels: ReadonlyArray<[TierStarTier, string]> = [
      ['low', 'Low Grit'],
      ['clear', 'Clear Goal'],
      ['stretch', 'Stretch Goal'],
    ];
    for (const [tier, label] of labels) {
      const component = renderer.create(<TierStar tier={tier} />);
      const svg = component.root.findByProps({ accessibilityRole: 'image' });
      expect(svg.props.accessibilityLabel).toBe(label);
    }
  });

  it('allows the accessibilityLabel to be overridden', () => {
    const component = renderer.create(<TierStar tier="low" accessibilityLabel="Custom" />);
    const svg = component.root.findByProps({ accessibilityRole: 'image' });
    expect(svg.props.accessibilityLabel).toBe('Custom');
  });

  it('renders an unmet star as a darkish-grey outline (no fill)', () => {
    const polygon = findPolygon(renderer.create(<TierStar tier="clear" />)).props;
    expect(polygon.fill).toBe('none');
    expect(polygon.stroke).toBe(colors.starMarker.outline);
    expect(polygon.filter).toBeUndefined();
  });

  it('renders a met star with a greyscale gradient fill and white glow', () => {
    const component = renderer.create(<TierStar tier="clear" met />);
    const polygon = findPolygon(component).props;
    // Filled with the gradient and outlined/glowing in white.
    expect(String(polygon.fill)).toMatch(/^url\(#/);
    expect(polygon.stroke).toBe(colors.starMarker.glow);
    expect(String(polygon.filter)).toMatch(/^url\(#/);
    // The gradient is greyscale: its light stop is the configured grey.
    const lightStop = component.root.find(
      (node: TestNode) => node.props.offset === '0' && 'stopColor' in node.props,
    );
    expect(lightStop.props.stopColor).toBe(colors.starMarker.gradientFrom);
  });

  it('honors an explicit size and forwards a testID', () => {
    const component = renderer.create(<TierStar tier="stretch" size={24} testID="my-star" />);
    expect(component.root.findAllByProps({ testID: 'my-star' }).length).toBeGreaterThan(0);
    expect(component.root.findAll((n: TestNode) => n.props.width === 24).length).toBeGreaterThan(0);
    expect(component.root.findAll((n: TestNode) => n.props.height === 24).length).toBeGreaterThan(
      0,
    );
  });

  it('points every star straight up (top vertex centered on the x-axis)', () => {
    const component = renderer.create(<TierStar tier="low" />);
    const [firstVertex] = findStarVertices(component);
    // First vertex is the top outer point: x at center (12), y above center.
    expect(Number(firstVertex![0])).toBeCloseTo(12, 3);
    expect(Number(firstVertex![1])).toBeLessThan(12);
  });
});
