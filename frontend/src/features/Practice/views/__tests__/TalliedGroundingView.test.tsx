import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { TalliedGroundingConfig } from '../../engine/types';
import TalliedGroundingView from '../TalliedGroundingView';

import { fakeControls, fakeState } from './fixtures';

// Find Shapes: 3 rounds × 3 categories × 3 items = 27 linear steps.
const config: TalliedGroundingConfig = {
  mode: 'tallied_grounding',
  rounds: 3,
  categories: [
    { key: 'squares', label: 'a square', target_count: 3 },
    { key: 'triangles', label: 'a triangle', target_count: 3 },
    { key: 'circles', label: 'a circle', target_count: 3 },
  ],
};

const TOTAL_STEPS = 27;

describe('TalliedGroundingView', () => {
  it('renders the categories-by-rounds badge', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-badge').props.children).toBe('3 × 3');
  });

  it('renders "Round 1 of 3" on the initial state', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-round').props.children).toBe('Round 1 of 3');
  });

  it('renders the first category prompt on the initial state', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-prompt').props.children).toBe('Find a square (1 of 3)');
  });

  it('decomposes a mid-round step into the right category and item', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 4 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-round').props.children).toBe('Round 1 of 3');
    expect(getByTestId('tallied-grounding-prompt').props.children).toBe('Find a triangle (2 of 3)');
  });

  it('advances into Round 2 after a full round of nine steps', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 9 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-round').props.children).toBe('Round 2 of 3');
    expect(getByTestId('tallied-grounding-prompt').props.children).toBe('Find a square (1 of 3)');
  });

  it('calls controls.tap when the advance button is pressed', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 2 })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('tallied-grounding-advance'));
    expect(controls.tap).toHaveBeenCalledTimes(1);
  });

  it('exposes a per-category accessibility label on the advance button', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 3 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-advance').props.accessibilityLabel).toBe(
      'Tally a triangle',
    );
  });

  it('disables the advance button while paused and ignores taps', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'paused', currentStepIndex: 1 })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('tallied-grounding-advance'));
    expect(controls.tap).not.toHaveBeenCalled();
    expect(getByTestId('tallied-grounding-advance').props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('shows the Start control while idle and forwards controls.start', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'idle', currentStepIndex: 0 })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('ritual-start'));
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('renders the Complete card and hides the advance button when complete', () => {
    const { getByTestId, queryByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'complete', currentStepIndex: TOTAL_STEPS })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-complete')).toBeTruthy();
    expect(queryByTestId('tallied-grounding-advance')).toBeNull();
    expect(queryByTestId('tallied-grounding-round')).toBeNull();
  });

  it('treats an overrun step index as complete', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: TOTAL_STEPS })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-complete')).toBeTruthy();
  });

  it('forwards onSave when the Save CTA is pressed', () => {
    const onSave = jest.fn();
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'complete', currentStepIndex: TOTAL_STEPS })}
        controls={fakeControls()}
        onSave={onSave}
      />,
    );
    fireEvent.press(getByTestId('tallied-grounding-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('disables the Save CTA when onSave is omitted', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'complete', currentStepIndex: TOTAL_STEPS })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-save').props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('sets the header accessibility role', () => {
    const { getByTestId } = render(
      <TalliedGroundingView
        config={config}
        state={fakeState({ status: 'running', currentStepIndex: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('tallied-grounding-header').props.accessibilityRole).toBe('header');
  });
});
