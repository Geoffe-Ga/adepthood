/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import ModeIcon from '../ModeIcon';
import ModePicker, { FALLBACK_MODE_ICON, MODE_CATEGORIES, type PickableMode } from '../ModePicker';

import { colors, surface } from '@/design/tokens';

const NEW_MODES: readonly PickableMode[] = [
  'tallied_grounding',
  'mindful_anchor',
  'random_interval_bell',
  'card_meditation',
];

describe('ModePicker — categories', () => {
  it('renders all five intent categories', () => {
    const { getByTestId } = render(<ModePicker onSelect={jest.fn()} />);
    expect(getByTestId('mode-picker-category-timers')).toBeTruthy();
    expect(getByTestId('mode-picker-category-bells')).toBeTruthy();
    expect(getByTestId('mode-picker-category-grounding')).toBeTruthy();
    expect(getByTestId('mode-picker-category-reflection')).toBeTruthy();
    expect(getByTestId('mode-picker-category-movement')).toBeTruthy();
  });

  it('places every mode under exactly one category', () => {
    const seen = new Set<string>();
    for (const category of MODE_CATEGORIES) {
      for (const entry of category.modes) {
        expect(seen.has(entry.mode)).toBe(false);
        seen.add(entry.mode);
      }
    }
    expect(seen.size).toBe(11);
  });

  it('renders all eleven mode rows across the categories', () => {
    const { getByTestId } = render(<ModePicker onSelect={jest.fn()} />);
    for (const category of MODE_CATEGORIES) {
      for (const entry of category.modes) {
        expect(getByTestId(`mode-picker-mode-${entry.mode}`)).toBeTruthy();
      }
    }
  });
});

// #2963: each mode reads by a drawn lucide glyph, not an emoji, and the glyph
// is decoration — the row's accessibilityLabel stays its whole accessible name.
describe('ModePicker — mode icons', () => {
  const entries = MODE_CATEGORIES.flatMap((category) => category.modes);

  it('gives every mode its own lucide icon, distinct from the fallback', () => {
    const icons = entries.map((entry) => entry.icon);
    expect(icons.every((icon) => typeof icon === 'function' || typeof icon === 'object')).toBe(
      true,
    );
    expect(new Set(icons).size).toBe(entries.length);
    expect(icons).not.toContain(FALLBACK_MODE_ICON);
  });

  it.each(entries.map((entry) => [entry.mode, entry] as const))(
    'draws the %s icon through the shared decorative ModeIcon, with no emoji text',
    (mode, entry) => {
      const { getByTestId } = render(<ModePicker onSelect={jest.fn()} />);
      const row = getByTestId(`mode-picker-mode-${mode}`);
      const icon = row.findByType(ModeIcon);
      expect(icon.props.icon).toBe(entry.icon);
      const slot = getByTestId(`mode-picker-icon-${mode}`, { includeHiddenElements: true });
      expect(slot.props.accessibilityElementsHidden).toBe(true);
      expect(slot.props.importantForAccessibility).toBe('no-hide-descendants');
      // The only text left in the row is its label and description (and New).
      const texts: unknown[] = row
        .findAllByType(Text)
        .map((node: { props: { children?: unknown } }) => node.props.children);
      const allowed: unknown[] = [entry.label, entry.description, 'New'];
      expect(texts).toEqual(expect.arrayContaining([entry.label, entry.description]));
      expect(texts.filter((text) => !allowed.includes(text))).toEqual([]);
      expect(row.props.accessibilityLabel).toBe(entry.label);
    },
  );
});

describe('ModePicker — selection', () => {
  it('calls onSelect with the tapped mode value', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(<ModePicker onSelect={onSelect} />);
    fireEvent.press(getByTestId('mode-picker-mode-random_interval_bell'));
    expect(onSelect).toHaveBeenCalledWith('random_interval_bell');
  });

  it('marks the currently selected mode with the radio-selected state', () => {
    const { getByTestId } = render(
      <ModePicker selectedMode="card_meditation" onSelect={jest.fn()} />,
    );
    const selected = getByTestId('mode-picker-mode-card_meditation');
    expect(selected.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    const other = getByTestId('mode-picker-mode-meditation_timer');
    expect(other.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
  });

  it('exposes the picker as a radio group for assistive tech', () => {
    const { getByTestId } = render(<ModePicker onSelect={jest.fn()} />);
    const group = getByTestId('mode-picker');
    expect(group.props.accessibilityRole).toBe('radiogroup');
    const row = getByTestId('mode-picker-mode-meditation_timer');
    expect(row.props.accessibilityRole).toBe('radio');
  });
});

describe('ModePicker — New badge', () => {
  it('shows the New tag on tallied_grounding, mindful_anchor, random_interval_bell, card_meditation', () => {
    const { getByTestId } = render(<ModePicker onSelect={jest.fn()} />);
    for (const mode of NEW_MODES) {
      expect(getByTestId(`mode-picker-new-${mode}`)).toBeTruthy();
    }
  });

  it('does not tag legacy modes as New', () => {
    const { queryByTestId } = render(<ModePicker onSelect={jest.fn()} />);
    const legacy: readonly PickableMode[] = [
      'meditation_timer',
      'count_up',
      'metronome',
      'interval_bell',
      'rep_counter',
      'sense_grounding',
      'tarot',
    ];
    for (const mode of legacy) {
      expect(queryByTestId(`mode-picker-new-${mode}`)).toBeNull();
    }
  });
});

// Candle & Ink token guard: selected mode row background is surface.sunken (#f3ecdf), migrated from legacy colors.background.accent (#f0f0f0).
describe('Candle & Ink token guard — ModePicker selected mode row', () => {
  const flatBackground = (style: unknown): string | undefined =>
    (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

  it('selected mode row background resolves to surface.sunken', () => {
    const { getByTestId } = render(
      <ModePicker selectedMode="card_meditation" onSelect={jest.fn()} />,
    );
    const selected = getByTestId('mode-picker-mode-card_meditation');
    // POST-migration expected value — the migrated semantic token value.
    expect(flatBackground(selected.props.style)).toBe(surface.sunken);
  });

  it('unselected mode row does not carry surface.sunken background', () => {
    const { getByTestId } = render(
      <ModePicker selectedMode="card_meditation" onSelect={jest.fn()} />,
    );
    const unselected = getByTestId('mode-picker-mode-meditation_timer');
    expect(flatBackground(unselected.props.style)).not.toBe(surface.sunken);
  });

  it('selected mode row does NOT use the legacy colors.background.accent value', () => {
    const { getByTestId } = render(
      <ModePicker selectedMode="card_meditation" onSelect={jest.fn()} />,
    );
    const selected = getByTestId('mode-picker-mode-card_meditation');
    expect(flatBackground(selected.props.style)).not.toBe(colors.background.accent);
  });
});
