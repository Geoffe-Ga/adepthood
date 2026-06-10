import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { SenseGroundingConfig } from '../../engine/types';
import SenseGroundingView from '../SenseGroundingView';

import { fakeControls, fakeState } from './fixtures';

const config: SenseGroundingConfig = {
  mode: 'sense_grounding',
  prompts: [
    { sense: 'sight', label: 'Five things you can see right now' },
    { sense: 'touch', label: 'Four things you can feel' },
    { sense: 'hearing', label: 'Three things you can hear' },
    { sense: 'smell', label: 'Two things you can smell' },
    { sense: 'taste', label: 'One thing you can taste' },
  ],
};

describe('SenseGroundingView', () => {
  it('renders the 5-4-3-2-1 badge and the current sense count', () => {
    const { getByTestId, getByText } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('sense-grounding-badge').props.children).toBe('5-4-3-2-1');
    expect(getByText('SEE')).toBeTruthy();
    expect(getByText(/5 things you can/)).toBeTruthy();
  });

  it('updates the header count to the current sense as steps advance', () => {
    const { getByText, queryByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 2 })}
        controls={fakeControls()}
      />,
    );
    // The derived "3 things you can HEAR" header is the single instruction —
    // the old duplicate per-prompt label line has been removed.
    expect(getByText(/3 things you can/)).toBeTruthy();
    expect(getByText('HEAR')).toBeTruthy();
    expect(queryByTestId('sense-grounding-prompt')).toBeNull();
  });

  it('labels the primary button "Mark <sense> done" per step', () => {
    const senses = ['sight', 'touch', 'hearing', 'smell', 'taste'] as const;
    for (const [idx, sense] of senses.entries()) {
      const { getByText, unmount } = render(
        <SenseGroundingView
          config={config}
          state={fakeState({ status: 'running', currentStepIndex: idx })}
          controls={fakeControls()}
        />,
      );
      expect(getByText(`Mark ${sense} done`)).toBeTruthy();
      unmount();
    }
  });

  it('calls controls.tap when the advance button is pressed', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 1 })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('sense-grounding-advance'));
    expect(controls.tap).toHaveBeenCalledTimes(1);
  });

  it('shows a primer and the Start control while idle, with no advance button', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'idle', currentStepIndex: 0 })}
        controls={controls}
      />,
    );
    // Before Start: a single primer + "Begin grounding". No dead, greyed-out
    // "Mark <sense> done" button and no per-sense count line.
    expect(getByTestId('sense-grounding-intro')).toBeTruthy();
    expect(queryByTestId('sense-grounding-advance')).toBeNull();
    expect(queryByTestId('sense-grounding-count')).toBeNull();
    fireEvent.press(getByTestId('ritual-start'));
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('renders the completion card and hides the advance button when complete', () => {
    const { getByTestId, queryByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({
          status: 'complete',
          currentStepIndex: config.prompts.length,
        })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('sense-grounding-complete')).toBeTruthy();
    expect(queryByTestId('sense-grounding-advance')).toBeNull();
  });

  it('renders a Save CTA in the complete card and forwards onSave when pressed', () => {
    const onSave = jest.fn();
    const { getByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({
          status: 'complete',
          currentStepIndex: config.prompts.length,
        })}
        controls={fakeControls()}
        onSave={onSave}
      />,
    );
    fireEvent.press(getByTestId('sense-grounding-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('disables the Save CTA when onSave is omitted', () => {
    const { getByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({
          status: 'complete',
          currentStepIndex: config.prompts.length,
        })}
        controls={fakeControls()}
      />,
    );
    const save = getByTestId('sense-grounding-save');
    expect(save.props.accessibilityState).toEqual({ disabled: true });
  });

  it('disables the advance button when paused and ignores taps', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'paused', currentStepIndex: 1 })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('sense-grounding-advance'));
    expect(controls.tap).not.toHaveBeenCalled();
    expect(getByTestId('sense-grounding-advance').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(getByTestId('ritual-resume')).toBeTruthy();
    expect(getByTestId('ritual-cancel')).toBeTruthy();
  });

  it('sets the header accessibility role', () => {
    const { getByTestId } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('sense-grounding-header').props.accessibilityRole).toBe('header');
  });

  it('exposes an accessibility label that updates with the current sense', () => {
    const { getByTestId, rerender } = render(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('sense-grounding-advance').props.accessibilityLabel).toBe('Mark sight done');
    rerender(
      <SenseGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 3 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('sense-grounding-advance').props.accessibilityLabel).toBe('Mark smell done');
  });
});
