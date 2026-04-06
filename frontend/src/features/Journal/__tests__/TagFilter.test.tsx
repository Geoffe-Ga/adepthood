/* eslint-env jest */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import TagFilter from '../TagFilter';

describe('TagFilter', () => {
  let onSelectTag: jest.Mock;

  beforeEach(() => {
    onSelectTag = jest.fn();
  });

  it('renders all filter chips', () => {
    const { getByText } = render(<TagFilter activeTag={null} onSelectTag={onSelectTag} />);
    expect(getByText('All')).toBeTruthy();
    expect(getByText('Freeform')).toBeTruthy();
    expect(getByText('Reflections')).toBeTruthy();
    expect(getByText('Practice Notes')).toBeTruthy();
    expect(getByText('Habit Notes')).toBeTruthy();
  });

  it('calls onSelectTag with tag value when chip is pressed', () => {
    const { getByText } = render(<TagFilter activeTag={null} onSelectTag={onSelectTag} />);
    fireEvent.press(getByText('Reflections'));
    expect(onSelectTag).toHaveBeenCalledWith('stage_reflection');
  });

  it('calls onSelectTag with freeform when Freeform chip is pressed', () => {
    const { getByText } = render(<TagFilter activeTag={null} onSelectTag={onSelectTag} />);
    fireEvent.press(getByText('Freeform'));
    expect(onSelectTag).toHaveBeenCalledWith('freeform');
  });

  it('calls onSelectTag with null when All is pressed', () => {
    const { getByText } = render(
      <TagFilter activeTag="stage_reflection" onSelectTag={onSelectTag} />,
    );
    fireEvent.press(getByText('All'));
    expect(onSelectTag).toHaveBeenCalledWith(null);
  });

  it('highlights the active chip', () => {
    const { getByTestId } = render(
      <TagFilter activeTag="stage_reflection" onSelectTag={onSelectTag} />,
    );
    const activeChip = getByTestId('tag-chip-stage_reflection');
    const inactiveChip = getByTestId('tag-chip-all');

    // Active chip should have the active style applied
    const activeStyles = activeChip.props.style;
    const inactiveStyles = inactiveChip.props.style;
    expect(activeStyles).not.toEqual(inactiveStyles);
  });

  it('deselects active tag when same chip is pressed', () => {
    const { getByText } = render(
      <TagFilter activeTag="stage_reflection" onSelectTag={onSelectTag} />,
    );
    fireEvent.press(getByText('Reflections'));
    expect(onSelectTag).toHaveBeenCalledWith(null);
  });
});
