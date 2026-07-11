/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Pure body suite for the Map header drawer's legend: ten stage rows ascending
// (1 at top), the persona/descriptor/balance-read a11y label, the current-stage
// marker, the locked-row unlock timeline, and the journey summary line.
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';

import { cycleLabel } from '../beginAgain';
import { journeyRead, unlockTimeline } from '../journeyNarrative';
import MapDrawer from '../MapDrawer';
import { STAGE_DISPLAY } from '../mapLayout';
import { STAGE_COUNT } from '../stageData';
import type { StageData } from '../stageData';
import { stageNodeLabel } from '../stageLegend';
import { FULLNESS_ALIVE_THRESHOLD } from '../wheelBalance';

import { mockMakeStage, mockMapState, resetMapMockState } from './mapTestHarness';

jest.mock('../../../store/useProgramProgression', () =>
  jest.requireActual('./mapTestHarness').mockProgramProgressionModule(),
);
jest.mock('../services/stageService', () =>
  jest.requireActual('./mapTestHarness').mockStageServiceModule(),
);

type TestNode = { props: Record<string, unknown> };

type Lookup = Readonly<Record<number, StageData | undefined>>;

const buildLookup = (): Lookup => {
  const lookup: Record<number, StageData> = {};
  for (let n = 1; n <= STAGE_COUNT; n += 1) {
    lookup[n] = mockMakeStage(n);
  }
  return lookup;
};

const requireDisplay = (stageNumber: number) => {
  const display = STAGE_DISPLAY[stageNumber];
  if (!display) throw new Error(`no STAGE_DISPLAY entry for stage ${stageNumber}`);
  return display;
};

describe('MapDrawer', () => {
  beforeEach(() => {
    resetMapMockState();
  });

  it('renders ten stage rows in ascending order, stage 1 at the top', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const stageRowPattern = /^map-drawer-stage-\d+$/;
    const rows = tree.root.findAll(
      (n: TestNode) =>
        typeof n.props.testID === 'string' && stageRowPattern.test(n.props.testID as string),
    );
    const order = [...new Set(rows.map((r: TestNode) => r.props.testID as string))];
    expect(order).toEqual(
      Array.from({ length: STAGE_COUNT }, (_, i) => `map-drawer-stage-${i + 1}`),
    );
  });

  it('colors each stage swatch with STAGE_DISPLAY.textColor', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    for (const n of [1, 5, 10]) {
      const swatch = tree.root.findByProps({ testID: `map-drawer-swatch-${n}` });
      const flat = StyleSheet.flatten(swatch.props.style) as { backgroundColor?: string };
      expect(flat.backgroundColor).toBe(requireDisplay(n).textColor);
    }
  });

  it('shows persona and descriptor text for every stage', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    for (let n = 1; n <= STAGE_COUNT; n += 1) {
      const display = requireDisplay(n);
      expect(
        tree.root.findAll((node: TestNode) => node.props.children === display.persona).length,
      ).toBeGreaterThan(0);
      expect(
        tree.root.findAll((node: TestNode) => node.props.children === display.descriptor).length,
      ).toBeGreaterThan(0);
    }
  });

  it('gives each row an accessibilityLabel matching stageNodeLabel', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{ 3: FULLNESS_ALIVE_THRESHOLD }}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const row = tree.root.findByProps({ testID: 'map-drawer-stage-3' });
    expect(row.props.accessibilityLabel).toBe(
      stageNodeLabel(requireDisplay(3), FULLNESS_ALIVE_THRESHOLD),
    );
  });

  it('gives each row accessibilityRole="button"', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const row = tree.root.findByProps({ testID: 'map-drawer-stage-7' });
    expect(row.props.accessibilityRole).toBe('button');
  });

  it('shows a reads-full caption when fullness meets the alive threshold', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{ 2: FULLNESS_ALIVE_THRESHOLD }}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const row = tree.root.findByProps({ testID: 'map-drawer-stage-2' });
    expect(row.findAll((n: TestNode) => n.props.children === 'reads full').length).toBeGreaterThan(
      0,
    );
  });

  it('shows a reads-thin caption when fullness is absent', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const row = tree.root.findByProps({ testID: 'map-drawer-stage-4' });
    expect(row.findAll((n: TestNode) => n.props.children === 'reads thin').length).toBeGreaterThan(
      0,
    );
  });

  it('marks only the current stage row selected, with its current marker', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={5}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const currentRow = tree.root.findByProps({ testID: 'map-drawer-stage-5' });
    expect(currentRow.props.accessibilityState).toEqual({ selected: true });
    expect(tree.root.findByProps({ testID: 'map-drawer-current-5' })).toBeTruthy();

    const otherRow = tree.root.findByProps({ testID: 'map-drawer-stage-6' });
    expect(otherRow.props.accessibilityState).toEqual({ selected: false });
  });

  it('shows the lock glyph and pluralised unlock copy for a locked row', () => {
    mockMapState.daysUntilStage = 5;
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const row = tree.root.findByProps({ testID: 'map-drawer-stage-5' });
    expect(row.findAll((n: TestNode) => n.props.children === '🔒').length).toBeGreaterThan(0);
    const unlockLine = tree.root.findByProps({ testID: 'map-drawer-unlock-5' });
    expect(unlockLine.props.children).toBe(unlockTimeline(5));
  });

  it('treats a stage missing from the lookup as locked', () => {
    mockMapState.daysUntilStage = 3;
    const lookup: Record<number, StageData> = {};
    for (let n = 1; n <= STAGE_COUNT; n += 1) {
      if (n !== 6) lookup[n] = mockMakeStage(n, { isUnlocked: true });
    }
    const tree = create(
      <MapDrawer
        lookup={lookup}
        currentStage={STAGE_COUNT}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const row = tree.root.findByProps({ testID: 'map-drawer-stage-6' });
    expect(row.findAll((n: TestNode) => n.props.children === '🔒').length).toBeGreaterThan(0);
    expect(tree.root.findByProps({ testID: 'map-drawer-unlock-6' })).toBeTruthy();
  });

  it('singularises "day" when exactly one day remains', () => {
    mockMapState.daysUntilStage = 1;
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const unlockLine = tree.root.findByProps({ testID: 'map-drawer-unlock-8' });
    expect(unlockLine.props.children).toBe(unlockTimeline(1));
    expect(unlockLine.props.children).toBe('Unlocks in 1 day');
  });

  it('falls back to the no-anchor copy when no days-until value is set', () => {
    mockMapState.daysUntilStage = null;
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const unlockLine = tree.root.findByProps({ testID: 'map-drawer-unlock-9' });
    expect(unlockLine.props.children).toBe(unlockTimeline(null));
    expect(unlockLine.props.children).toBe('Unlocks as your journey reaches it');
  });

  it('fires onSelectStage with the stage number when an unlocked row is tapped', () => {
    const onSelectStage = jest.fn();
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={onSelectStage}
      />,
    );
    act(() => {
      tree.root.findByProps({ testID: 'map-drawer-stage-2' }).props.onPress();
    });
    expect(onSelectStage).toHaveBeenCalledWith(2);
  });

  it('fires onSelectStage even for a locked row', () => {
    const onSelectStage = jest.fn();
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={onSelectStage}
      />,
    );
    act(() => {
      tree.root.findByProps({ testID: 'map-drawer-stage-8' }).props.onPress();
    });
    expect(onSelectStage).toHaveBeenCalledWith(8);
  });

  it('shows the journey summary line with journeyRead copy', () => {
    mockMapState.derivedWeek = 4;
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={3}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    const summary = tree.root.findByProps({ testID: 'map-drawer-journey' });
    expect(
      summary.findAll((n: TestNode) => n.props.children === journeyRead(3, 4, STAGE_COUNT)).length,
    ).toBeGreaterThan(0);
  });

  it('shows the cycle label only when cycleNumber is greater than 1', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={2}
        onSelectStage={jest.fn()}
      />,
    );
    expect(
      tree.root.findAll((n: TestNode) => n.props.children === cycleLabel(2)).length,
    ).toBeGreaterThan(0);
  });

  it('hides the cycle label when cycleNumber is 1', () => {
    const tree = create(
      <MapDrawer
        lookup={buildLookup()}
        currentStage={1}
        fullnessByStage={{}}
        cycleNumber={1}
        onSelectStage={jest.fn()}
      />,
    );
    expect(tree.root.findAll((n: TestNode) => n.props.children === cycleLabel(1)).length).toBe(0);
  });
});
