/* eslint-env jest */
/* global describe, it, expect */
import React from 'react';
import renderer from 'react-test-renderer';

import { TierStar, type TierStarTier } from '../TierStar';

// react-test-renderer ships no type definitions in this project, so test
// instances are annotated structurally (matching the pattern in the other
// HabitTile/GoalModal renderer tests) to satisfy ``noImplicitAny``.
interface TestNode {
  props: Record<string, unknown>;
}

type Rendered = ReturnType<typeof renderer.create>;

/** Pull the single star Polygon's vertex list out of a rendered TierStar. */
const findStarVertices = (component: Rendered): string[][] => {
  const polygon: TestNode = component.root.find(
    (node: TestNode) => typeof node.props.points === 'string',
  );
  return String(polygon.props.points)
    .trim()
    .split(' ')
    .map((pair) => pair.split(','));
};

describe('TierStar', () => {
  // A star with N points is drawn as N outer + N inner vertices = 2N total.
  const cases: ReadonlyArray<[TierStarTier, number]> = [
    ['low', 4],
    ['clear', 5],
    ['stretch', 10],
  ];

  it.each(cases)('renders %s as a %d-pointed star', (tier, points) => {
    const component = renderer.create(<TierStar tier={tier} color="#000000" />);
    expect(findStarVertices(component)).toHaveLength(points * 2);
  });

  it('defaults the accessibilityLabel to the spoken tier name', () => {
    const labels: ReadonlyArray<[TierStarTier, string]> = [
      ['low', 'Low Grit'],
      ['clear', 'Clear Goal'],
      ['stretch', 'Stretch Goal'],
    ];
    for (const [tier, label] of labels) {
      const component = renderer.create(<TierStar tier={tier} color="#000000" />);
      const svg = component.root.findByProps({ accessibilityRole: 'image' });
      expect(svg.props.accessibilityLabel).toBe(label);
    }
  });

  it('allows the accessibilityLabel to be overridden', () => {
    const component = renderer.create(
      <TierStar tier="low" color="#000000" accessibilityLabel="Custom" />,
    );
    const svg = component.root.findByProps({ accessibilityRole: 'image' });
    expect(svg.props.accessibilityLabel).toBe('Custom');
  });

  it('applies the tier color as the stroke', () => {
    const component = renderer.create(<TierStar tier="clear" color="#be6e46" />);
    const polygon: TestNode = component.root.find(
      (node: TestNode) => typeof node.props.points === 'string',
    );
    expect(polygon.props.stroke).toBe('#be6e46');
    // Outlined (stroke-only) to match the lucide bottom-tab icon style.
    expect(polygon.props.fill).toBe('none');
  });

  it('honors an explicit size and forwards a testID', () => {
    const component = renderer.create(
      <TierStar tier="stretch" color="#8c3b2e" size={24} testID="my-star" />,
    );
    // The testID is forwarded onto the rendered SVG.
    expect(component.root.findAllByProps({ testID: 'my-star' }).length).toBeGreaterThan(0);
    // The explicit size flows through to a width/height-bearing node.
    expect(component.root.findAll((n: TestNode) => n.props.width === 24).length).toBeGreaterThan(0);
    expect(component.root.findAll((n: TestNode) => n.props.height === 24).length).toBeGreaterThan(
      0,
    );
  });

  it('points every star straight up (top vertex centered on the x-axis)', () => {
    const component = renderer.create(<TierStar tier="low" color="#000000" />);
    const [firstVertex] = findStarVertices(component);
    // First vertex is the top outer point: x at center (12), y above center.
    expect(Number(firstVertex![0])).toBeCloseTo(12, 3);
    expect(Number(firstVertex![1])).toBeLessThan(12);
  });
});
