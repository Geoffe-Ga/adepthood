/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image, Text } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapDrawer from '../MapDrawer';
import MapScreen from '../MapScreen';
import type { StageData } from '../stageData';

import { mockMapState, resetMapMocks } from './mapTestHarness';
import {
  createCanonicalStages,
  GOLDEN_ROWS,
  GOLDEN_STAGE_NUMBERS,
  GOLDEN_WATERMARKS,
  goldenStage,
} from './stageVocabularyGolden';

/**
 * The Map speaks the same words before and after #2666 (golden, characterization).
 *
 * Rendered from ten stages exactly as a freshly seeded `GET /stages` serves
 * them, every surface that carries stage vocabulary -- the left column, the
 * arrow labels, the title watermarks, the right column and its fallback lines,
 * the grid's spoken labels, the lens's spoken identity and the drawer rows --
 * must read the golden. This file and its fixture were committed before the
 * static mirrors were removed and are unchanged by that removal.
 */

jest.mock('react-native/Libraries/Interaction/InteractionManager', () =>
  jest.requireActual('./mapTestHarness').mockInteractionManagerModule(),
);
jest.mock('../../../navigation/hooks', () =>
  jest.requireActual('./mapTestHarness').mockNavigationModule(),
);
jest.mock('@react-navigation/bottom-tabs', () =>
  jest.requireActual('./mapTestHarness').mockBottomTabsModule(),
);
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('./mapTestHarness').mockSafeAreaModule(),
);
jest.mock('../hooks/useWheelBalance', () =>
  jest.requireActual('./mapTestHarness').mockWheelBalanceModule(),
);
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));
jest.mock('../../../store/useProgramProgression', () =>
  jest.requireActual('./mapTestHarness').mockProgramProgressionModule(),
);
jest.mock('../services/stageService', () =>
  jest.requireActual('./mapTestHarness').mockStageServiceModule(),
);
jest.mock('../../../store/useStageStore', () =>
  jest.requireActual('./mapTestHarness').mockStageStoreModule(),
);

type TestNode = {
  props: Record<string, unknown>;
  findAllByType: (_type: unknown) => TestNode[];
};
type Tree = ReturnType<typeof create>;

/** A grid large enough for the lens to mount over it. */
const GRID_LAYOUT = { width: 300, height: 600 };

/** A cell too narrow for any ramp step, which forces every fallback line. */
const NO_FIT_WIDTH = 1;

const fireLayout = (node: TestNode, layout: { width: number; height: number }): void => {
  act(() => {
    (node.props.onLayout as (_e: unknown) => void)({ nativeEvent: { layout } });
  });
};

const byTestId = (tree: Tree, testID: string): TestNode =>
  tree.root.findByProps({ testID }) as unknown as TestNode;

/** Every string a node renders as a `Text` child, in order. */
const textsUnder = (node: TestNode): string[] =>
  node
    .findAllByType(Text)
    .map((child) => child.props.children)
    .filter((children): children is string => typeof children === 'string');

const renderMap = (): Tree => {
  const tree = create(<MapScreen />);
  fireLayout(byTestId(tree, 'map-grid'), GRID_LAYOUT);
  return tree;
};

const label = (node: TestNode): string => {
  const value = node.props.accessibilityLabel;
  if (typeof value !== 'string') throw new Error('the node carries no accessibility label');
  return value;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Matches `base` followed by nothing but the current/locked state markers. */
const withStateSuffix = (base: string): RegExp =>
  new RegExp(`^${escapeRegExp(base)}(, current)?(, locked)?$`, 'u');

describe('the Map vocabulary golden', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = createCanonicalStages();
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it.each(GOLDEN_STAGE_NUMBERS)('stage %i reads its persona and descriptor', (n) => {
    const { persona, descriptor } = goldenStage(n);
    const tree = renderMap();
    const texts = textsUnder(byTestId(tree, `stage-text-fit-${n}`));
    expect(texts.slice(0, 2)).toEqual([persona, descriptor]);
    expect(label(byTestId(tree, `stage-hotspot-${n}-0`))).toMatch(
      new RegExp(`^${escapeRegExp(`${persona} - ${descriptor} - `)}reads (full|thin)`, 'u'),
    );
  });

  it.each(GOLDEN_STAGE_NUMBERS)(
    'stage %i carries its arrow label, or none on a title stage',
    (n) => {
      const { arrowLabel } = goldenStage(n);
      const tree = renderMap();
      const blocks = tree.root.findAllByProps({ testID: `aspect-label-${n}` });
      if (arrowLabel === '') {
        expect(blocks).toHaveLength(0);
        return;
      }
      expect(blocks.length).toBeGreaterThan(0);
      const texts = textsUnder(blocks[0] as unknown as TestNode);
      expect(texts[0]).toBe(arrowLabel);
    },
  );

  it('spells the two title watermarks, top line first', () => {
    const tree = renderMap();
    for (const watermark of GOLDEN_WATERMARKS) {
      expect(textsUnder(byTestId(tree, `title-fit-${watermark}`))).toEqual([watermark]);
    }
    const watermarks = GOLDEN_STAGE_NUMBERS.map((n) => goldenStage(n).watermark).filter(
      (w): w is string => w !== undefined,
    );
    expect([...watermarks].reverse()).toEqual(GOLDEN_WATERMARKS);
  });

  it.each(GOLDEN_ROWS.map((row) => [row.category, row] as const))(
    'the %s row labels its band and falls back to its hyphenated lines',
    (category, row) => {
      const tree = renderMap();
      expect(byTestId(tree, `map-row-${category}`)).toBeTruthy();
      const fit = byTestId(tree, `right-label-fit-${category}`);
      fireLayout(fit, { width: NO_FIT_WIDTH, height: 20 });
      expect(textsUnder(byTestId(tree, `right-label-fit-${category}`))).toEqual(row.fallbackLines);
      for (const stageNumber of row.stageNumbers) {
        expect(goldenStage(stageNumber).category).toBe(category);
      }
    },
  );

  it.each(GOLDEN_STAGE_NUMBERS)('the lens names stage %i by its golden identity', (n) => {
    mockMapState.currentStage = n;
    mockMapState.derivedStage = n;
    const tree = renderMap();
    const lens = byTestId(tree, 'map-magnifier');
    expect(label(lens)).toContain(`Magnifier over ${goldenStage(n).lensIdentity}.`);
  });

  it.each(GOLDEN_STAGE_NUMBERS)('the drawer row for stage %i reads its category and arrow', (n) => {
    const lookup: Record<number, StageData> = Object.fromEntries(
      createCanonicalStages().map((stage) => [stage.stageNumber, stage]),
    );
    const tree = create(
      <MapDrawer lookup={lookup} currentStage={1} cycleNumber={1} onSelectStage={jest.fn()} />,
    );
    const { category, arrowLabel } = goldenStage(n);
    const base = arrowLabel ? `${category}, ${arrowLabel}` : category;
    const row = byTestId(tree, `map-drawer-stage-${n}`);
    expect(label(row)).toMatch(withStateSuffix(base));
  });
});
