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

const NEAR_PREFIX = 'near-';
const FAR_PREFIX = 'far-';

// react-native-svg's Polygon renders an internal Path, so raw findAllByType(Path)
// over-counts. Select wave paths by our explicit testIDs and the Path type only.
const testIdOf = (node: WavePath): string =>
  typeof node.props.testID === 'string' ? node.props.testID : '';

const wavePathsWithPrefix = (tree: Renderer, prefix: string): WavePath[] =>
  tree.root.findAll((node: WavePath) => node.type === Path && testIdOf(node).startsWith(prefix));

describe('WaveOverlay', () => {
  it('renders exactly one wave path per segment and no far-side strand', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    expect(wavePathsWithPrefix(tree, NEAR_PREFIX)).toHaveLength(SEGMENT_COUNT);
    expect(wavePathsWithPrefix(tree, FAR_PREFIX)).toHaveLength(0);
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

  it('colors each near-<stage> path the exact stage textColor', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    for (let stage = 1; stage <= SEGMENT_COUNT; stage += 1) {
      const near = tree.root.findByProps({ testID: `${NEAR_PREFIX}${stage}` });
      expect(near.props.stroke).toBe(STAGE_DISPLAY[stage]?.textColor);
    }
  });

  it('still renders all 10 arrowheads on top of the wave paths', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const arrowheads = tree.root.findAllByType(Polygon);
    expect(arrowheads).toHaveLength(STAGE_COUNT);
  });
});
