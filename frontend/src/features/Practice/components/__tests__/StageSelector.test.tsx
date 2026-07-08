/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import StageSelector from '../StageSelector';

import { accent, BORDER_RADIUS, editorialType, ink, surface } from '@/design/tokens';

const flatten = (style: unknown): Record<string, unknown> =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

describe('StageSelector — shared chip set', () => {
  it('renders exactly 10 numbered stage chips for stages 1..10', () => {
    const { getByTestId } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} testIDPrefix="stage" />,
    );
    for (let n = 1; n <= 10; n += 1) {
      expect(getByTestId(`stage-${n}`)).toBeTruthy();
    }
  });

  it('renders the visible chip label as String(n) by default', () => {
    const { getByText } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} testIDPrefix="stage" />,
    );
    expect(getByText('7')).toBeTruthy();
  });
});

describe('StageSelector — radio variant', () => {
  it('exposes each numbered chip as a radio', () => {
    const { getByTestId } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} testIDPrefix="stage" />,
    );
    expect(getByTestId('stage-3').props.accessibilityRole).toBe('radio');
  });

  it('labels each numbered chip Stage N for assistive tech, independent of formatLabel', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="radio"
        onSelect={jest.fn()}
        formatLabel={(n) => `S${n}`}
        testIDPrefix="stage"
      />,
    );
    expect(getByTestId('stage-3').props.accessibilityLabel).toBe('Stage 3');
  });

  it('does not render a skip chip when onSkip is not provided', () => {
    const { queryByTestId } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} testIDPrefix="stage" />,
    );
    expect(queryByTestId('stage-skip')).toBeNull();
  });

  it('renders a skip chip labeled Stage Skip when onSkip is provided', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="radio"
        onSelect={jest.fn()}
        onSkip={jest.fn()}
        testIDPrefix="stage"
      />,
    );
    const skip = getByTestId('stage-skip');
    expect(skip.props.accessibilityRole).toBe('radio');
    expect(skip.props.accessibilityLabel).toBe('Stage Skip');
  });

  it('marks the skip chip selected when selectedStage is null', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="radio"
        onSelect={jest.fn()}
        onSkip={jest.fn()}
        selectedStage={null}
        testIDPrefix="stage"
      />,
    );
    expect(getByTestId('stage-skip').props.accessibilityState).toEqual({ selected: true });
  });

  it('marks the skip chip unselected when a numbered stage is selected', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="radio"
        onSelect={jest.fn()}
        onSkip={jest.fn()}
        selectedStage={3}
        testIDPrefix="stage"
      />,
    );
    expect(getByTestId('stage-skip').props.accessibilityState).toEqual({ selected: false });
  });

  it('marks the selected numbered chip with accessibilityState selected true', () => {
    const { getByTestId } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} selectedStage={3} testIDPrefix="stage" />,
    );
    expect(getByTestId('stage-3').props.accessibilityState).toEqual({ selected: true });
  });

  it('applies the selected container and text token colors to the selected chip', () => {
    const { getByTestId, getByText } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} selectedStage={3} testIDPrefix="stage" />,
    );
    const container = flatten(getByTestId('stage-3').props.style);
    expect(container.backgroundColor).toBe(accent.primary);
    expect(container.borderColor).toBe(accent.primary);
    const text = flatten(getByText('3').props.style);
    expect(text.color).toBe(accent.onPrimary);
  });

  it('applies the unselected container and text token colors to an unselected chip', () => {
    const { getByTestId, getByText } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} selectedStage={3} testIDPrefix="stage" />,
    );
    const container = flatten(getByTestId('stage-5').props.style);
    expect(container.backgroundColor).toBe(surface.raised);
    expect(container.borderColor).toBe(surface.hairline);
    const text = flatten(getByText('5').props.style);
    expect(text.fontFamily).toBe(editorialType.note.fontFamily);
    expect(text.fontSize).toBe(editorialType.note.fontSize);
    expect(text.lineHeight).toBe(editorialType.note.lineHeight);
    expect(text.fontWeight).toBe(editorialType.note.fontWeight);
    expect(text.color).toBe(ink.primary);
  });

  it('calls onSelect with the tapped stage number', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <StageSelector variant="radio" onSelect={onSelect} testIDPrefix="stage" />,
    );
    fireEvent.press(getByTestId('stage-6'));
    expect(onSelect).toHaveBeenCalledWith(6);
  });

  it('calls onSkip when the skip chip is pressed', () => {
    const onSkip = jest.fn();
    const { getByTestId } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} onSkip={onSkip} testIDPrefix="stage" />,
    );
    fireEvent.press(getByTestId('stage-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('does not set a row testID when rowTestID is omitted', () => {
    const { queryByTestId } = render(
      <StageSelector variant="radio" onSelect={jest.fn()} testIDPrefix="stage" />,
    );
    expect(queryByTestId('stage-row')).toBeNull();
  });
});

describe('StageSelector — filter variant', () => {
  it('exposes each numbered chip as a button', () => {
    const { getByTestId } = render(
      <StageSelector variant="filter" onSelect={jest.fn()} testIDPrefix="filter" />,
    );
    expect(getByTestId('filter-3').props.accessibilityRole).toBe('button');
  });

  it('renders the visible label from formatLabel while the a11y label stays in the Stage N form', () => {
    const { getByTestId, getByText } = render(
      <StageSelector
        variant="filter"
        onSelect={jest.fn()}
        formatLabel={(n) => `Stage ${n}`}
        testIDPrefix="filter"
      />,
    );
    expect(getByText('Stage 3')).toBeTruthy();
    expect(getByTestId('filter-3').props.accessibilityLabel).toBe('Stage 3');
  });

  it('applies the fixed filter-chip text style', () => {
    const { getByText } = render(
      <StageSelector
        variant="filter"
        onSelect={jest.fn()}
        formatLabel={(n) => `Stage ${n}`}
        testIDPrefix="filter"
      />,
    );
    const text = flatten(getByText('Stage 3').props.style);
    expect(text).toEqual({ fontSize: 12, fontWeight: '600', color: ink.primary });
  });

  it('sets rowTestID on the wrapping row when provided', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="filter"
        onSelect={jest.fn()}
        testIDPrefix="filter"
        rowTestID="filter-row"
      />,
    );
    expect(getByTestId('filter-row')).toBeTruthy();
  });

  it('merges rowStyle into the flattened row style', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="filter"
        onSelect={jest.fn()}
        testIDPrefix="filter"
        rowTestID="filter-row"
        rowStyle={{ marginTop: 42 }}
      />,
    );
    const row = flatten(getByTestId('filter-row').props.style);
    expect(row.marginTop).toBe(42);
  });

  it('applies the selected background to the selected filter chip', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="filter"
        onSelect={jest.fn()}
        selectedStage={4}
        testIDPrefix="filter"
      />,
    );
    const container = flatten(getByTestId('filter-4').props.style);
    expect(container.backgroundColor).toBe(accent.primary);
  });

  it('calls onSelect with the tapped stage number', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <StageSelector variant="filter" onSelect={onSelect} testIDPrefix="filter" />,
    );
    fireEvent.press(getByTestId('filter-8'));
    expect(onSelect).toHaveBeenCalledWith(8);
  });
});

describe('StageSelector — picker variant', () => {
  it('exposes each numbered chip as a button', () => {
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} testIDPrefix="picker" />,
    );
    expect(getByTestId('picker-3').props.accessibilityRole).toBe('button');
  });

  it('defaults accessibilityState to disabled false and never carries a selected key', () => {
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} testIDPrefix="picker" />,
    );
    const state = getByTestId('picker-3').props.accessibilityState;
    expect(state).toEqual({ disabled: false });
    expect(state.selected).toBeUndefined();
  });

  it('sets accessibilityState disabled true when disabled', () => {
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} disabled testIDPrefix="picker" />,
    );
    const state = getByTestId('picker-3').props.accessibilityState;
    expect(state).toEqual({ disabled: true });
    expect(state.selected).toBeUndefined();
  });

  it('never carries a selected key even when selectedStage is passed', () => {
    const { getByTestId } = render(
      <StageSelector
        variant="picker"
        onSelect={jest.fn()}
        selectedStage={3}
        testIDPrefix="picker"
      />,
    );
    const state = getByTestId('picker-3').props.accessibilityState as Record<string, unknown>;
    expect(state.selected).toBeUndefined();
  });

  it('calls onSelect with the tapped stage number when enabled', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={onSelect} testIDPrefix="picker" />,
    );
    fireEvent.press(getByTestId('picker-2'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('suppresses onPress entirely when disabled', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={onSelect} disabled testIDPrefix="picker" />,
    );
    const chip = getByTestId('picker-2');
    expect(chip.props.onPress).toBeUndefined();
    fireEvent.press(chip);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('applies the fixed picker-box container style', () => {
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} testIDPrefix="picker" />,
    );
    const container = flatten(getByTestId('picker-3').props.style);
    expect(container.minWidth).toBe(36);
    expect(container.backgroundColor).toBe(surface.sunken);
    expect(container.borderRadius).toBe(BORDER_RADIUS.sm);
    expect(container.alignItems).toBe('center');
  });

  it('applies the fixed picker text style', () => {
    const { getByText } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} testIDPrefix="picker" />,
    );
    const text = flatten(getByText('4').props.style);
    expect(text.color).toBe(ink.primary);
    expect(text.fontWeight).toBe('700');
  });

  it('adds opacity 0.5 to the container when disabled', () => {
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} disabled testIDPrefix="picker" />,
    );
    const container = flatten(getByTestId('picker-3').props.style);
    expect(container.opacity).toBe(0.5);
  });

  it('does not dim the container when not disabled', () => {
    const { getByTestId } = render(
      <StageSelector variant="picker" onSelect={jest.fn()} testIDPrefix="picker" />,
    );
    const container = flatten(getByTestId('picker-3').props.style);
    expect(container.opacity).not.toBe(0.5);
  });
});
