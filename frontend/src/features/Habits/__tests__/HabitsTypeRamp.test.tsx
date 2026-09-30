import { readFileSync } from 'fs';
import path from 'path';

import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import renderer from 'react-test-renderer';

// HabitsScreen (for PaginationBar) pulls these in at import time; stub them so
// the module loads, in the explicit default-export form the sibling chrome
// tests use. Factories are inlined because jest hoists jest.mock.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
}));
jest.mock('../components/AddHabitModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/GoalModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/HabitSettingsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/MissedDaysModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/OnboardingModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ReorderHabitsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: () => null }));

import { legalFontSizes } from '../../../../e2e/textCensus';
import { INTERACTIVE_TEXT_MIN } from '../../../design/tokens';
import type { Habit } from '../Habits.types';
import { PaginationBar } from '../HabitsScreen';
import { HabitTile } from '../HabitTile';

/**
 * #2961 — the Habits grid sets every text size on the `type(width)` ramp.
 *
 * The grid used to size its text as `spacing(n, scale)`, where `scale` is the
 * `useResponsive` layout scale (a breakpoint factor times a 0.85 short-height
 * factor). That put the tile name, streak, emoji, tooltip, locked tile and
 * pager at 10.8/12.6/14.4/21.6px on a phone and 14.4/16.8/19.2/38.4px on a
 * desktop — none of them sizes the type ramp offers. These tests render every
 * text-bearing piece of the grid and hold each size to the census's legal set,
 * pin the face each role takes, keep the pager's tappable labels at the
 * interactive floor, and show that text now follows width alone.
 */

type ReactTestInstance = ReturnType<typeof renderer.create>['root'];

const mockWindowDimensions = (width: number, height: number): void => {
  jest
    .spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({ width, height, scale: 1, fontScale: 1 });
};

const noop = (): void => {};

const habit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Water',
  icon: '💧',
  streak: 4,
  energy_cost: 0,
  energy_return: 0,
  start_date: new Date(),
  goals: [
    {
      title: 'Low',
      tier: 'low',
      target: 10,
      target_unit: 'oz',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      title: 'Clear',
      tier: 'clear',
      target: 20,
      target_unit: 'oz',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      title: 'Stretch',
      tier: 'stretch',
      target: 30,
      target_unit: 'oz',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 5 }],
  ...overrides,
});

const LOCKED_NAME = 'Journal';

/** One unlocked tile (tooltip open), one locked tile, and the pager, at `width`. */
const renderGrid = (width: number, height: number): ReactTestInstance => {
  mockWindowDimensions(width, height);
  const tree = renderer.create(
    <>
      <HabitTile habit={habit()} tz="UTC" onOpenGoals={noop} onLongPress={noop} />
      <HabitTile habit={habit({ id: 2, name: LOCKED_NAME })} locked tz="UTC" />
      <PaginationBar
        page={0}
        pageCount={2}
        onPrev={noop}
        onNext={noop}
        width={width}
        stageStart={1}
        stageEnd={5}
      />
    </>,
  );
  renderer.act(() => {
    tree.root.findByProps({ testID: 'marker-clear' }).props.onMouseEnter();
  });
  return tree.root;
};

const fontSizeOf = (node: ReactTestInstance): number | undefined =>
  StyleSheet.flatten(node.props.style)?.fontSize;

const sizedTexts = (root: ReactTestInstance): ReactTestInstance[] =>
  root.findAllByType(Text).filter((node: ReactTestInstance) => fontSizeOf(node) !== undefined);

/** Text of a host `Text` node, joined, so a node can be found by what it reads. */
const textOf = (node: ReactTestInstance): string => {
  const { children } = node.props as { children?: unknown };
  return (Array.isArray(children) ? children : [children]).join('');
};

const sizeOfText = (root: ReactTestInstance, match: (_text: string) => boolean): number => {
  const node = root
    .findAllByType(Text)
    .find((candidate: ReactTestInstance) => match(textOf(candidate)));
  if (node === undefined) throw new Error('no Text matched');
  const size = fontSizeOf(node);
  if (size === undefined) throw new Error(`"${textOf(node)}" sets no fontSize`);
  return size;
};

const sizeUnder = (root: ReactTestInstance, testID: string): number => {
  const [host] = root.findAllByProps({ testID });
  if (host === undefined) throw new Error(`no ${testID}`);
  const node = host.type === Text ? host : host.findByType(Text);
  const size = fontSizeOf(node);
  if (size === undefined) throw new Error(`${testID} sets no fontSize`);
  return size;
};

/** Every role's size, read back off the rendered grid. */
const roleSizes = (root: ReactTestInstance) => ({
  name: sizeOfText(root, (text) => text === 'Water'),
  streak: sizeOfText(root, (text) => text.includes('DAYS')),
  icon: sizeUnder(root, 'habit-icon'),
  tooltip: sizeUnder(root, 'tooltip-clear'),
  lockGlyph: sizeOfText(root, (text) => text === '🔒'),
  lockedName: sizeOfText(root, (text) => text === LOCKED_NAME),
  lockedSubtitle: sizeUnder(root, 'unlock-label'),
  prev: sizeUnder(root, 'pagination-prev'),
  next: sizeUnder(root, 'pagination-next'),
  paginationLabel: sizeUnder(root, 'pagination-label'),
});

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 720 } as const;
const SHORT_PHONE = { width: 390, height: 640 } as const;
// Name, streak, icon, tooltip, lock glyph, locked name, locked subtitle, Prev,
// the Stages label and Next: every text node the grid sizes.
const GRID_SIZED_TEXT_COUNT = 10;

describe('Habits grid type ramp (#2961)', () => {
  it.each([
    [PHONE.width, PHONE.height],
    [DESKTOP.width, DESKTOP.height],
    [SHORT_PHONE.width, SHORT_PHONE.height],
  ])('sets every Habits grid text node on the type ramp at %ix%i', (width, height) => {
    const root = renderGrid(width, height);

    // Non-vacuity: every sized piece of the grid actually rendered.
    expect(root.findAllByProps({ testID: 'tooltip-clear' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'habit-icon-top' }).length > 0).toBe(
      width === DESKTOP.width,
    );
    const sizes = sizedTexts(root).map(fontSizeOf);
    expect(sizes).toHaveLength(GRID_SIZED_TEXT_COUNT);

    const legal = legalFontSizes(width);
    const offRamp = [...new Set(sizes)].filter((size) => !legal.has(size as number));
    expect(offRamp).toEqual([]);
  });

  it('pins each role to its ramp face on a phone', () => {
    expect(roleSizes(renderGrid(PHONE.width, PHONE.height))).toEqual({
      name: 14,
      streak: 13,
      icon: 20,
      tooltip: 13,
      lockGlyph: 14,
      lockedName: 14,
      lockedSubtitle: 13,
      prev: 16,
      next: 16,
      paginationLabel: 14,
    });
  });

  it('pins each role to its ramp face on a desktop, with the icon stacked', () => {
    expect(roleSizes(renderGrid(DESKTOP.width, DESKTOP.height))).toEqual({
      name: 17,
      streak: 15,
      icon: 40,
      tooltip: 15,
      lockGlyph: 17,
      lockedName: 17,
      lockedSubtitle: 15,
      prev: 16,
      next: 16,
      paginationLabel: 17,
    });
  });

  it.each([
    [PHONE.width, PHONE.height],
    [DESKTOP.width, DESKTOP.height],
    [320, 568],
  ])('keeps the pager Prev/Next labels at the interactive floor at %ix%i', (width, height) => {
    const root = renderGrid(width, height);
    expect(sizeUnder(root, 'pagination-prev')).toBeGreaterThanOrEqual(INTERACTIVE_TEXT_MIN);
    expect(sizeUnder(root, 'pagination-next')).toBeGreaterThanOrEqual(INTERACTIVE_TEXT_MIN);
  });

  it('sizes text by width alone: a short viewport keeps the phone sizes', () => {
    const tall = roleSizes(renderGrid(PHONE.width, PHONE.height));
    const short = roleSizes(renderGrid(SHORT_PHONE.width, SHORT_PHONE.height));
    expect(short).toEqual(tall);
  });

  it('leaves no layout-scaled font size in the grid source', () => {
    const scaledFontSize = /fontSize:\s*spacing\(/g;
    for (const file of ['HabitTile.tsx', 'HabitsScreen.tsx']) {
      const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect({ file, matches: source.match(scaledFontSize) ?? [] }).toEqual({ file, matches: [] });
    }
  });
});
