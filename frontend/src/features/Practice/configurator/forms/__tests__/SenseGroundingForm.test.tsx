import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';

import type { SenseGroundingConfig } from '../../../engine/types';
import SenseGroundingForm from '../SenseGroundingForm';

function senseConfig(): SenseGroundingConfig {
  return {
    mode: 'sense_grounding',
    prompts: [
      { sense: 'sight', label: 'A' },
      { sense: 'hearing', label: 'B' },
      { sense: 'touch', label: 'C' },
    ],
  };
}

function Harness({ initial }: { initial: SenseGroundingConfig }): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return <SenseGroundingForm value={value} onChange={setValue} />;
}

describe('SenseGroundingForm row identity', () => {
  it('keeps an open dropdown attached to its row when the row moves up', () => {
    const { getByTestId, queryByTestId } = render(<Harness initial={senseConfig()} />);
    fireEvent.press(getByTestId('sense-prompt-1-thing-trigger'));
    expect(queryByTestId('sense-prompt-1-panel')).toBeTruthy();

    fireEvent.press(getByTestId('sense-prompt-1-up'));

    expect(queryByTestId('sense-prompt-0-panel')).toBeTruthy();
    expect(queryByTestId('sense-prompt-1-panel')).toBeNull();
  });

  it('keeps an open dropdown on the surviving row after a non-tail delete', () => {
    const { getByTestId, queryByTestId } = render(<Harness initial={senseConfig()} />);
    fireEvent.press(getByTestId('sense-prompt-1-thing-trigger'));

    fireEvent.press(getByTestId('sense-prompt-0-remove'));

    expect(queryByTestId('sense-prompt-0-panel')).toBeTruthy();
  });
});

describe('SenseGroundingForm payloads', () => {
  it('appends a blank sight prompt', () => {
    const onChange = jest.fn();
    const config = senseConfig();
    const { getByTestId } = render(<SenseGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('sense-grounding-add'));

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      prompts: [...config.prompts, { sense: 'sight', label: '' }],
    });
  });

  it('patches the label at the edited index', () => {
    const onChange = jest.fn();
    const config = senseConfig();
    const { getByTestId } = render(<SenseGroundingForm value={config} onChange={onChange} />);

    fireEvent.changeText(getByTestId('sense-prompt-1-label'), 'Edited');

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      prompts: [config.prompts[0], { ...config.prompts[1]!, label: 'Edited' }, config.prompts[2]],
    });
  });

  it('swaps the two prompts in the onChange payload on a move', () => {
    const onChange = jest.fn();
    const config = senseConfig();
    const { getByTestId } = render(<SenseGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('sense-prompt-1-down'));

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      prompts: [config.prompts[0], config.prompts[2], config.prompts[1]],
    });
  });

  it('filters the removed prompt out of the payload', () => {
    const onChange = jest.fn();
    const config = senseConfig();
    const { getByTestId } = render(<SenseGroundingForm value={config} onChange={onChange} />);

    fireEvent.press(getByTestId('sense-prompt-1-remove'));

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      prompts: [config.prompts[0], config.prompts[2]],
    });
  });

  it('treats first-row up and last-row down as disabled no-ops', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <SenseGroundingForm value={senseConfig()} onChange={onChange} />,
    );

    fireEvent.press(getByTestId('sense-prompt-0-up'));
    fireEvent.press(getByTestId('sense-prompt-2-down'));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SenseGroundingForm testIDs', () => {
  it('exposes the add button and per-row action testIDs', () => {
    const { getByTestId } = render(
      <SenseGroundingForm value={senseConfig()} onChange={jest.fn()} />,
    );

    expect(getByTestId('sense-grounding-add')).toBeTruthy();
    expect(getByTestId('sense-prompt-0-label')).toBeTruthy();
    expect(getByTestId('sense-prompt-0-up')).toBeTruthy();
    expect(getByTestId('sense-prompt-0-down')).toBeTruthy();
    expect(getByTestId('sense-prompt-0-remove')).toBeTruthy();
  });
});
