import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';

import type { MindfulAnchorConfig } from '../../../engine/types';
import MindfulAnchorForm from '../MindfulAnchorForm';

function anchorConfig(): MindfulAnchorConfig {
  return {
    mode: 'mindful_anchor',
    instruction: 'Stand on grass',
    min_duration_seconds: 60,
    options: [
      { key: 'o1', label: 'Bare feet' },
      { key: 'o2', label: 'Socks' },
    ],
    require_option_choice: false,
  };
}

function Harness({ initial }: { initial: MindfulAnchorConfig }): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return <MindfulAnchorForm value={value} onChange={setValue} />;
}

describe('MindfulAnchorForm add', () => {
  it('appends a new row with a generated option_N key and a blank label', () => {
    const onChange = jest.fn();
    const config = anchorConfig();
    const { getByTestId } = render(<MindfulAnchorForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('anchor-add-option'));

    const next = onChange.mock.calls[0]![0] as MindfulAnchorConfig;
    expect(next.options).toHaveLength(3);
    expect(next.options[2]!.key).toMatch(/^option_\d+$/);
    expect(next.options[2]!.label).toBe('');
  });

  it('gives two successive additions distinct keys', () => {
    const onChange = jest.fn();
    const { getByTestId, rerender } = render(
      <MindfulAnchorForm value={anchorConfig()} onChange={onChange} />,
    );

    fireEvent.press(getByTestId('anchor-add-option'));
    const first = onChange.mock.calls[0]![0] as MindfulAnchorConfig;
    rerender(<MindfulAnchorForm value={first} onChange={onChange} />);
    fireEvent.press(getByTestId('anchor-add-option'));
    const second = onChange.mock.calls[1]![0] as MindfulAnchorConfig;

    expect(second.options[3]!.key).not.toBe(first.options[2]!.key);
  });
});

describe('MindfulAnchorForm edit-then-delete', () => {
  it('preserves the surviving row value and its original persisted key', () => {
    const { getByTestId } = render(<Harness initial={anchorConfig()} />);

    fireEvent.changeText(getByTestId('anchor-option-1-label'), 'Typed');
    fireEvent.press(getByTestId('anchor-option-0-remove'));

    expect(getByTestId('anchor-option-0-label').props.value).toBe('Typed');
  });

  it('keeps the surviving option key unchanged in the onChange payload', () => {
    const onChange = jest.fn();
    const config = anchorConfig();
    const { getByTestId, rerender } = render(
      <MindfulAnchorForm value={config} onChange={onChange} />,
    );

    fireEvent.changeText(getByTestId('anchor-option-1-label'), 'Typed');
    const edited = onChange.mock.calls[0]![0] as MindfulAnchorConfig;
    rerender(<MindfulAnchorForm value={edited} onChange={onChange} />);

    fireEvent.press(getByTestId('anchor-option-0-remove'));
    const afterRemove = onChange.mock.calls[1]![0] as MindfulAnchorConfig;

    expect(afterRemove.options).toEqual([{ key: 'o2', label: 'Typed' }]);
  });
});

describe('MindfulAnchorForm payloads', () => {
  it('patches the label and description at the right index', () => {
    const onChange = jest.fn();
    const config = anchorConfig();
    const { getByTestId } = render(<MindfulAnchorForm value={config} onChange={onChange} />);

    fireEvent.changeText(getByTestId('anchor-option-1-label'), 'New socks');
    expect(onChange).toHaveBeenCalledWith({
      ...config,
      options: [config.options[0], { ...config.options[1]!, label: 'New socks' }],
    });

    fireEvent.changeText(getByTestId('anchor-option-1-description'), 'Thick wool');
    expect(onChange).toHaveBeenCalledWith({
      ...config,
      options: [config.options[0], { ...config.options[1]!, description: 'Thick wool' }],
    });
  });

  it('leaves the scalar fields addressable by their unchanged testIDs', () => {
    const onChange = jest.fn();
    const config = anchorConfig();
    const { getByTestId } = render(<MindfulAnchorForm value={config} onChange={onChange} />);

    fireEvent.changeText(getByTestId('anchor-instruction'), 'Stand on grass and breathe');
    expect(onChange).toHaveBeenCalledWith({ ...config, instruction: 'Stand on grass and breathe' });

    fireEvent.changeText(getByTestId('anchor-min-duration'), '90');
    expect(onChange).toHaveBeenCalledWith({ ...config, min_duration_seconds: 90 });

    fireEvent(getByTestId('anchor-require-choice'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledWith({ ...config, require_option_choice: true });
  });
});

describe('MindfulAnchorForm testIDs and labels', () => {
  it('exposes the row, add, and remove testIDs and their accessibility labels', () => {
    const { getByTestId } = render(
      <MindfulAnchorForm value={anchorConfig()} onChange={jest.fn()} />,
    );

    expect(getByTestId('anchor-option-0')).toBeTruthy();
    expect(getByTestId('anchor-option-0-label')).toBeTruthy();
    expect(getByTestId('anchor-option-0-description')).toBeTruthy();
    expect(getByTestId('anchor-add-option').props.accessibilityLabel).toBe('Add option');
    expect(getByTestId('anchor-option-0-remove').props.accessibilityLabel).toBe('Remove option 1');
    expect(getByTestId('anchor-option-1-remove').props.accessibilityLabel).toBe('Remove option 2');
  });
});
