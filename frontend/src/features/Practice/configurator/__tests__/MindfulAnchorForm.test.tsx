/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { MindfulAnchorConfig } from '../../engine/types';
import MindfulAnchorForm from '../forms/MindfulAnchorForm';

const base: MindfulAnchorConfig = {
  mode: 'mindful_anchor',
  instruction: 'Stand on grass',
  min_duration_seconds: 60,
  options: [{ key: 'o1', label: 'Bare feet' }],
  require_option_choice: false,
};

describe('MindfulAnchorForm', () => {
  it('edits the instruction', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('anchor-instruction'), 'Stand on grass and breathe');
    expect(onChange).toHaveBeenCalledWith({ ...base, instruction: 'Stand on grass and breathe' });
  });

  it('edits the minimum duration', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('anchor-min-duration'), '90');
    expect(onChange).toHaveBeenCalledWith({ ...base, min_duration_seconds: 90 });
  });

  it('toggles require-option-choice', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent(getByTestId('anchor-require-choice'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledWith({ ...base, require_option_choice: true });
  });

  it('edits an option label and description', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('anchor-option-0-label'), 'Socks');
    expect(onChange).toHaveBeenCalledWith({
      ...base,
      options: [{ key: 'o1', label: 'Socks' }],
    });
    fireEvent.changeText(getByTestId('anchor-option-0-description'), 'Thin socks');
    expect(onChange).toHaveBeenCalledWith({
      ...base,
      options: [{ key: 'o1', label: 'Bare feet', description: 'Thin socks' }],
    });
  });

  it('appends a new option with a generated stable key', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('anchor-add-option'));
    const next = onChange.mock.calls[0]![0] as MindfulAnchorConfig;
    expect(next.options).toHaveLength(2);
    expect(next.options[1]!.key).not.toBe('o1');
  });

  it('removes an option', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('anchor-option-0-remove'));
    expect(onChange).toHaveBeenCalledWith({ ...base, options: [] });
  });
});
