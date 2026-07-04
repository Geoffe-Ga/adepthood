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
const PAIR_COUNT = STAGE_COUNT - 1;
const TOTAL_NEAR_PATH_COUNT = PAIR_COUNT * 2;
const FULL_OPACITY = 1;

const HALF_LOWER = 'lower';
const HALF_UPPER = 'upper';
const NEAR_PREFIX = 'near-';
const FAR_PREFIX = 'far-';

// react-native-svg's Polygon renders an internal Path, so raw findAllByType(Path)
// over-counts. Select wave paths by our explicit testIDs and the Path type only.
const testIdOf = (node: WavePath): string =>
  typeof node.props.testID === 'string' ? node.props.testID : '';

const wavePathsWithPrefix = (tree: Renderer, prefix: string): WavePath[] =>
  tree.root.findAll((node: WavePath) => node.type === Path && testIdOf(node).startsWith(prefix));

const nearTestId = (stageNumber: number, half: string): string =>
  `${NEAR_PREFIX}${stageNumber}-${half}`;

describe('WaveOverlay', () => {
  it('renders exactly two wave paths per pair (a lower and an upper half) and no far-side strand', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    expect(wavePathsWithPrefix(tree, NEAR_PREFIX)).toHaveLength(TOTAL_NEAR_PATH_COUNT);
    expect(wavePathsWithPrefix(tree, FAR_PREFIX)).toHaveLength(0);
  });

  it('gives every near-<stage>-<half> path a unique testID', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const testIds = wavePathsWithPrefix(tree, NEAR_PREFIX).map(testIdOf);
    expect(new Set(testIds).size).toBe(TOTAL_NEAR_PATH_COUNT);
  });

  it('prefixes every testID when idPrefix is set (the magnifier copy)', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} idPrefix="magnifier-" />);
    expect(tree.root.findByProps({ testID: 'magnifier-map-wave' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'magnifier-wave-arrow-1' })).toBeTruthy();
    expect(wavePathsWithPrefix(tree, `magnifier-${NEAR_PREFIX}`)).toHaveLength(
      TOTAL_NEAR_PATH_COUNT,
    );
    // The unprefixed ids are gone, so the two overlay copies never collide.
    expect(tree.root.findAll((n: WavePath) => testIdOf(n) === 'map-wave')).toHaveLength(0);
  });

  it('leaves every near-<stage>-<half> path at full opacity', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const nearPaths = wavePathsWithPrefix(tree, NEAR_PREFIX);
    expect(nearPaths).toHaveLength(TOTAL_NEAR_PATH_COUNT);
    for (const near of nearPaths) {
      const opacity = near.props.strokeOpacity;
      const isFullOpacity = opacity === undefined || opacity === FULL_OPACITY;
      expect(isFullOpacity).toBe(true);
    }
  });

  it('colors each near-<stage>-lower path with that stage textColor', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    for (let stage = 1; stage <= PAIR_COUNT; stage += 1) {
      const near = tree.root.findByProps({ testID: nearTestId(stage, HALF_LOWER) });
      expect(near.props.stroke).toBe(STAGE_DISPLAY[stage]?.textColor);
    }
  });

  it('colors each near-<stage>-upper path with the next stage textColor', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    for (let stage = 1; stage <= PAIR_COUNT; stage += 1) {
      const near = tree.root.findByProps({ testID: nearTestId(stage, HALF_UPPER) });
      expect(near.props.stroke).toBe(STAGE_DISPLAY[stage + 1]?.textColor);
    }
  });

  it('still renders all 10 arrowheads on top of the wave paths, with unchanged colors', () => {
    const tree = create(<WaveOverlay width={WIDTH} height={HEIGHT} />);
    const arrowheads = tree.root.findAllByType(Polygon);
    expect(arrowheads).toHaveLength(STAGE_COUNT);
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const arrow = tree.root.findByProps({ testID: `wave-arrow-${stage}` });
      expect(arrow.props.fill).toBe(STAGE_DISPLAY[stage]?.textColor);
    }
  });
});
