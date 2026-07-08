import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';

import type { TalliedGroundingConfig } from '../../../engine/types';
import TalliedGroundingForm from '../TalliedGroundingForm';

function talliedConfig(): TalliedGroundingConfig {
  return {
    mode: 'tallied_grounding',
    rounds: 2,
    categories: [
      { key: 'c1', label: 'Red things', target_count: 3 },
      { key: 'c2', label: 'Round things', target_count: 5 },
    ],
  };
}

function Harness({ initial }: { initial: TalliedGroundingConfig }): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return <TalliedGroundingForm value={value} onChange={setValue} />;
}

describe('TalliedGroundingForm add', () => {
  it('appends a new row with a generated category_N key, blank label and target_count 1', () => {
    const onChange = jest.fn();
    const config = talliedConfig();
    const { getByTestId } = render(<TalliedGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('tallied-add-category'));

    const next = onChange.mock.calls[0]![0] as TalliedGroundingConfig;
    expect(next.categories).toHaveLength(3);
    expect(next.categories[2]!.key).toMatch(/^category_\d+$/);
    expect(next.categories[2]!.label).toBe('');
    expect(next.categories[2]!.target_count).toBe(1);
  });

  it('gives two successive additions distinct keys', () => {
    const onChange = jest.fn();
    const { getByTestId, rerender } = render(
      <TalliedGroundingForm value={talliedConfig()} onChange={onChange} />,
    );

    fireEvent.press(getByTestId('tallied-add-category'));
    const first = onChange.mock.calls[0]![0] as TalliedGroundingConfig;
    rerender(<TalliedGroundingForm value={first} onChange={onChange} />);
    fireEvent.press(getByTestId('tallied-add-category'));
    const second = onChange.mock.calls[1]![0] as TalliedGroundingConfig;

    expect(second.categories[3]!.key).not.toBe(first.categories[2]!.key);
  });
});

describe('TalliedGroundingForm edit-then-delete', () => {
  it('preserves the surviving row value after a non-tail delete', () => {
    const { getByTestId } = render(<Harness initial={talliedConfig()} />);

    fireEvent.changeText(getByTestId('tallied-category-1-label'), 'Typed');
    fireEvent.press(getByTestId('tallied-category-0-remove'));

    expect(getByTestId('tallied-category-0-label').props.value).toBe('Typed');
  });

  it('keeps the surviving category key unchanged in the onChange payload', () => {
    const onChange = jest.fn();
    const config = talliedConfig();
    const { getByTestId, rerender } = render(
      <TalliedGroundingForm value={config} onChange={onChange} />,
    );

    fireEvent.changeText(getByTestId('tallied-category-1-label'), 'Typed');
    const edited = onChange.mock.calls[0]![0] as TalliedGroundingConfig;
    rerender(<TalliedGroundingForm value={edited} onChange={onChange} />);

    fireEvent.press(getByTestId('tallied-category-0-remove'));
    const afterRemove = onChange.mock.calls[1]![0] as TalliedGroundingConfig;

    expect(afterRemove.categories).toEqual([{ key: 'c2', label: 'Typed', target_count: 5 }]);
  });
});

describe('TalliedGroundingForm steppers and remove', () => {
  it('patches target_count at the right index via the stepper', () => {
    const onChange = jest.fn();
    const config = talliedConfig();
    const { getByTestId } = render(<TalliedGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('tallied-category-1-count-plus'));

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      categories: [config.categories[0], { ...config.categories[1]!, target_count: 6 }],
    });
  });

  it('patches rounds via its stepper', () => {
    const onChange = jest.fn();
    const config = talliedConfig();
    const { getByTestId } = render(<TalliedGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('tallied-rounds-plus'));

    expect(onChange).toHaveBeenCalledWith({ ...config, rounds: 3 });
  });

  it('filters the removed category out of the payload', () => {
    const onChange = jest.fn();
    const config = talliedConfig();
    const { getByTestId } = render(<TalliedGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('tallied-category-1-remove'));

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      categories: [config.categories[0]],
    });
  });
});

describe('TalliedGroundingForm testIDs', () => {
  it('exposes the row, label, count, remove, and add testIDs', () => {
    const { getByTestId } = render(
      <TalliedGroundingForm value={talliedConfig()} onChange={jest.fn()} />,
    );

    expect(getByTestId('tallied-category-0')).toBeTruthy();
    expect(getByTestId('tallied-category-0-label')).toBeTruthy();
    expect(getByTestId('tallied-category-0-count')).toBeTruthy();
    expect(getByTestId('tallied-category-0-remove')).toBeTruthy();
    expect(getByTestId('tallied-add-category')).toBeTruthy();
  });
});
