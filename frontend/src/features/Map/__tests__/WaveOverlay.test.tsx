/* eslint-env jest */
/* global describe, it, expect */
import React from 'react';
import { Path, Polygon } from 'react-native-svg';
import { create } from 'react-test-renderer';

import { STAGE_DISPLAY } from '../mapLayout';
import { STAGE_COUNT } from '../stageData';
import WaveOverlay from '../WaveOverlay';

type Renderer = ReturnType<typeof create>;
type WavePath = ReturnType<Renderer['root']['findAll']>[number];

const WIDTH = 100;
const HEIGHT = 200;
const SEGMENT_COUNT = STAGE_COUNT - 1;
const FULL_OPACITY = 1;
const NOT_FOUND = -1;

const FAR_PREFIX = 'far-';
const NEAR_PREFIX = 'near-';

// react-native-svg's Polygon renders an internal Path, so raw findAllByType(Path)
// over-counts. Select wave paths by our explicit testIDs and the Path type only.
const testIdOf = (node: WavePath): string =>
  typeof node.props.testID === 'string' ? node.props.testID : '';

const wavePathsWithPrefix = (tree: Renderer, prefix: string): WavePath[] =>
  tree.root.findAll((node: WavePath) => node.type === Path && testIdOf(node).startsWith(prefix));

const orderedWavePaths = (tree: Renderer): WavePath[] =>
  tree.root.findAll(
    (node: WavePath) =>
      node.type === Path &&
      (testIdOf(node).startsWith(FAR_PREFIX) || testIdOf(node).startsWith(NEAR_PREFIX)),
  );

describe('WaveOverlay', () => {
  it('renders one far and one near wave path per segment', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    expect(wavePathsWithPrefix(tree, FAR_PREFIX)).toHaveLength(SEGMENT_COUNT);
    expect(wavePathsWithPrefix(tree, NEAR_PREFIX)).toHaveLength(SEGMENT_COUNT);
  });

  it('gives each far-<stage> path the exact stage color and reduced opacity', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    for (let stage = 1; stage <= SEGMENT_COUNT; stage += 1) {
      const far = tree.root.findByProps({ testID: `${FAR_PREFIX}${stage}` });
      const expectedColor = STAGE_DISPLAY[stage]?.textColor;
      expect(far.props.stroke).toBe(expectedColor);
      expect(far.props.strokeOpacity).toBeLessThan(FULL_OPACITY);
    }
  });

  it('leaves every near-<stage> path at full opacity', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const nearPaths = wavePathsWithPrefix(tree, NEAR_PREFIX);
    expect(nearPaths).toHaveLength(SEGMENT_COUNT);
    for (const near of nearPaths) {
      const opacity = near.props.strokeOpacity;
      const isFullOpacity = opacity === undefined || opacity === FULL_OPACITY;
      expect(isFullOpacity).toBe(true);
    }
  });

  it('colors each near-<stage> path the same exact stage color as its far path', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    for (let stage = 1; stage <= SEGMENT_COUNT; stage += 1) {
      const near = tree.root.findByProps({ testID: `${NEAR_PREFIX}${stage}` });
      expect(near.props.stroke).toBe(STAGE_DISPLAY[stage]?.textColor);
    }
  });

  it('renders the far path before the near path for every segment', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const ordered = orderedWavePaths(tree);
    for (let stage = 1; stage <= SEGMENT_COUNT; stage += 1) {
      const farIndex = ordered.findIndex((path) => testIdOf(path) === `${FAR_PREFIX}${stage}`);
      const nearIndex = ordered.findIndex((path) => testIdOf(path) === `${NEAR_PREFIX}${stage}`);
      expect(farIndex).toBeGreaterThan(NOT_FOUND);
      expect(nearIndex).toBeGreaterThan(NOT_FOUND);
      expect(farIndex).toBeLessThan(nearIndex);
    }
  });

  it('still renders all 10 arrowheads on top of the far and near paths', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const arrowheads = tree.root.findAllByType(Polygon);
    expect(arrowheads).toHaveLength(STAGE_COUNT);
  });
});
