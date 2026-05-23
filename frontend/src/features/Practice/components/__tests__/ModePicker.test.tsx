/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import ModePicker, { MODE_CATEGORIES, type PickableMode } from '../ModePicker';

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
