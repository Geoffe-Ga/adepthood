/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import ModePicker, { MODE_CATEGORIES, type PickableMode } from '../ModePicker';

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

// ---------------------------------------------------------------------------
// Gate 1 RED — Candle & Ink token guard for ModePicker selected mode row
//
// The selected row background must migrate from `colors.background.accent`
// (#f0f0f0) to `surface.sunken` (#f3ecdf). Every assertion below FAILS today
// because ModePicker still reads `styles.rowSelected = { backgroundColor:
// colors.background.accent }`.
// ---------------------------------------------------------------------------

describe('Candle & Ink token guard — ModePicker selected mode row', () => {
  const flatBackground = (style: unknown): string | undefined =>
    (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

  it('selected mode row background resolves to surface.sunken', () => {
    const { getByTestId } = render(
      <ModePicker selectedMode="card_meditation" onSelect={jest.fn()} />,
    );
    const selected = getByTestId('mode-picker-mode-card_meditation');
    // POST-migration expected value — RED today (component returns #f0f0f0).
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
