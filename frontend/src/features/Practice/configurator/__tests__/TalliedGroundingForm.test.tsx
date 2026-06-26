/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { TalliedGroundingConfig } from '../../engine/types';
import TalliedGroundingForm from '../forms/TalliedGroundingForm';

const base: TalliedGroundingConfig = {
  mode: 'tallied_grounding',
  rounds: 2,
  categories: [{ key: 'c1', label: 'Red things', target_count: 3 }],
};

describe('TalliedGroundingForm', () => {
  it('increments the rounds count', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TalliedGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('tallied-rounds-plus'));
    expect(onChange).toHaveBeenCalledWith({ ...base, rounds: 3 });
  });

  it('edits a category label', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TalliedGroundingForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('tallied-category-0-label'), 'Blue things');
    expect(onChange).toHaveBeenCalledWith({
      ...base,
      categories: [{ key: 'c1', label: 'Blue things', target_count: 3 }],
    });
  });

  it('changes a category target count', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TalliedGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('tallied-category-0-count-plus'));
    expect(onChange).toHaveBeenCalledWith({
      ...base,
      categories: [{ key: 'c1', label: 'Red things', target_count: 4 }],
    });
  });

  it('appends a new category with a generated stable key', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TalliedGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('tallied-add-category'));
    const next = onChange.mock.calls[0]![0] as TalliedGroundingConfig;
    expect(next.categories).toHaveLength(2);
    expect(next.categories[1]!.key).not.toBe('c1');
    expect(next.categories[1]!.label).toBe('');
  });

  it('removes a category', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TalliedGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('tallied-category-0-remove'));
    expect(onChange).toHaveBeenCalledWith({ ...base, categories: [] });
  });
});
