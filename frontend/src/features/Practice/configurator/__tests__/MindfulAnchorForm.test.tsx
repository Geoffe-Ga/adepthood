/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { MindfulAnchorConfig } from '../../engine/types';
import { OPTION_KEY_PATTERN, validateModeConfig } from '../../engine/validation';
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
    const newKey = next.options[1]!.key;
    expect(newKey).not.toBe('o1');
    // The generated key must satisfy the validator the same module enforces.
    expect(OPTION_KEY_PATTERN.test(newKey)).toBe(true);
    // The shipped bug was a *key* error (a field the form can't edit). A new
    // row may still report an empty-label error (the user fills that in) — but
    // never a key error.
    expect(validateModeConfig(next).some((e) => /key/i.test(e))).toBe(false);
  });

  it('removes an option', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('anchor-option-0-remove'));
    expect(onChange).toHaveBeenCalledWith({ ...base, options: [] });
  });

  it('renders with no options and still offers the add button', () => {
    const onChange = jest.fn();
    const empty: MindfulAnchorConfig = { ...base, options: [] };
    const { getByTestId, queryByTestId } = render(
      <MindfulAnchorForm value={empty} onChange={onChange} />,
    );
    expect(getByTestId('mindful-anchor-form')).toBeTruthy();
    expect(getByTestId('anchor-add-option')).toBeTruthy();
    expect(queryByTestId('anchor-option-0')).toBeNull();
  });

  it('keeps the surviving option after a non-tail delete (stable keys)', () => {
    const two: MindfulAnchorConfig = {
      ...base,
      options: [
        { key: 'o1', label: 'Bare feet' },
        { key: 'o2', label: 'Socks' },
      ],
    };
    const onChange = jest.fn();
    const { getByTestId } = render(<MindfulAnchorForm value={two} onChange={onChange} />);
    fireEvent.press(getByTestId('anchor-option-0-remove'));
    expect(onChange).toHaveBeenCalledWith({ ...base, options: [{ key: 'o2', label: 'Socks' }] });
  });
});
