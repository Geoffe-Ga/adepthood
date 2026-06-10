import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { SensePrompt } from '../../../engine/types';
import GroundingDropdown from '../GroundingDropdown';

const prompt: SensePrompt = { sense: 'sight', label: 'something blue' };

function open(value: SensePrompt = prompt): ReturnType<typeof render> & { onChange: jest.Mock } {
  const onChange = jest.fn();
  const utils = render(<GroundingDropdown index={0} value={value} onChange={onChange} />);
  fireEvent.press(utils.getByTestId('sense-prompt-0-thing-trigger'));
  return Object.assign(utils, { onChange });
}

describe('GroundingDropdown', () => {
  it('echoes the catalogue label and sense for a known prompt', () => {
    const { getByText, getByTestId } = render(
      <GroundingDropdown index={0} value={prompt} onChange={jest.fn()} />,
    );
    expect(getByText('Blue')).toBeTruthy();
    expect(getByTestId('sense-prompt-0-sense-badge')).toHaveTextContent('Sight');
  });

  it('is collapsed until the trigger is pressed', () => {
    const { queryByTestId, getByTestId } = render(
      <GroundingDropdown index={0} value={prompt} onChange={jest.fn()} />,
    );
    expect(queryByTestId('sense-prompt-0-panel')).toBeNull();
    fireEvent.press(getByTestId('sense-prompt-0-thing-trigger'));
    expect(getByTestId('sense-prompt-0-panel')).toBeTruthy();
  });

  it('picks a catalogue anchor, setting both sense and the seeded label', () => {
    // "something blue" is a catalogue prompt, so it counts as default and the
    // label is reseeded to the newly chosen anchor.
    const { getByTestId, onChange } = open();
    fireEvent.press(getByTestId('sense-prompt-0-option-sound_far'));
    expect(onChange).toHaveBeenCalledWith({ sense: 'hearing', label: 'a faraway sound' });
  });

  it('filters the catalogue by search query', () => {
    const { getByTestId, queryByTestId } = open();
    fireEvent.changeText(getByTestId('sense-prompt-0-search'), 'triangle');
    expect(getByTestId('sense-prompt-0-option-shape_triangle')).toBeTruthy();
    expect(queryByTestId('sense-prompt-0-option-colour_red')).toBeNull();
  });

  it('shows an empty-state when nothing matches', () => {
    const { getByTestId } = open();
    fireEvent.changeText(getByTestId('sense-prompt-0-search'), 'zzzz-nope');
    expect(getByTestId('sense-prompt-0-empty')).toBeTruthy();
  });

  it('creates a custom anchor from the search text with a chosen sense', () => {
    const { getByTestId, onChange } = open();
    fireEvent.changeText(getByTestId('sense-prompt-0-search'), 'a warm mug');
    fireEvent.press(getByTestId('sense-prompt-0-create-sense-touch'));
    fireEvent.press(getByTestId('sense-prompt-0-create'));
    expect(onChange).toHaveBeenCalledWith({ sense: 'touch', label: 'a warm mug' });
  });

  it('does not offer create until the query is non-empty', () => {
    const { getByTestId, queryByTestId } = open();
    expect(queryByTestId('sense-prompt-0-create-section')).toBeNull();
    fireEvent.changeText(getByTestId('sense-prompt-0-search'), 'x');
    expect(getByTestId('sense-prompt-0-create-section')).toBeTruthy();
  });

  it('keeps a user-edited custom label when only swapping the sense', () => {
    const custom: SensePrompt = { sense: 'sight', label: 'Name 5 things you can see' };
    const { getByTestId, onChange } = open(custom);
    fireEvent.press(getByTestId('sense-prompt-0-option-sense_hearing'));
    expect(onChange).toHaveBeenCalledWith({ sense: 'hearing' });
  });
});
