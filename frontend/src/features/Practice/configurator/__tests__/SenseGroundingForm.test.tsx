import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { SenseGroundingConfig } from '../../engine/types';
import SenseGroundingForm from '../forms/SenseGroundingForm';

const base: SenseGroundingConfig = {
  mode: 'sense_grounding',
  prompts: [
    { sense: 'sight', label: '5 things you can see' },
    { sense: 'hearing', label: '4 things you can hear' },
    { sense: 'touch', label: '3 things you can feel' },
  ],
};

describe('SenseGroundingForm', () => {
  it('renders one row per prompt', () => {
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('sense-prompt-0')).toBeTruthy();
    expect(getByTestId('sense-prompt-1')).toBeTruthy();
    expect(getByTestId('sense-prompt-2')).toBeTruthy();
  });

  it('edits a prompt label', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('sense-prompt-0-label'), 'Five colours');
    expect(onChange).toHaveBeenCalledWith({
      mode: 'sense_grounding',
      prompts: [{ sense: 'sight', label: 'Five colours' }, base.prompts[1], base.prompts[2]],
    });
  });

  it('changes the sense via the searchable dropdown, preserving a custom label', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={onChange} />);
    // Custom label ("5 things you can see") is not a catalogue prompt, so
    // picking a new anchor only swaps the sense and keeps the wording.
    fireEvent.press(getByTestId('sense-prompt-0-thing-trigger'));
    fireEvent.press(getByTestId('sense-prompt-0-option-sense_smell'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'sense_grounding',
      prompts: [
        { sense: 'smell', label: '5 things you can see' },
        base.prompts[1],
        base.prompts[2],
      ],
    });
  });

  it('seeds the label when picking an anchor for a still-default prompt', () => {
    const onChange = jest.fn();
    const seeded: SenseGroundingConfig = {
      mode: 'sense_grounding',
      prompts: [{ sense: 'sight', label: '' }],
    };
    const { getByTestId } = render(<SenseGroundingForm value={seeded} onChange={onChange} />);
    fireEvent.press(getByTestId('sense-prompt-0-thing-trigger'));
    fireEvent.press(getByTestId('sense-prompt-0-option-colour_red'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'sense_grounding',
      prompts: [{ sense: 'sight', label: 'something red' }],
    });
  });

  it('reorders prompts via the up/down arrows', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('sense-prompt-1-up'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'sense_grounding',
      prompts: [base.prompts[1], base.prompts[0], base.prompts[2]],
    });
  });

  it('removes a prompt', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('sense-prompt-1-remove'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'sense_grounding',
      prompts: [base.prompts[0], base.prompts[2]],
    });
  });

  it('adds a new blank prompt', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('sense-grounding-add'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'sense_grounding',
      prompts: [...base.prompts, { sense: 'sight', label: '' }],
    });
  });

  it('disables the up arrow for the first row and the down arrow for the last', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<SenseGroundingForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('sense-prompt-0-up'));
    fireEvent.press(getByTestId('sense-prompt-2-down'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
