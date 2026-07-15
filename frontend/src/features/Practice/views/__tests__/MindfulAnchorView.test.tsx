import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { MindfulAnchorConfig } from '../../engine/types';
import MindfulAnchorView from '../MindfulAnchorView';

import { fakeControls, fakeState } from './fixtures';

const optionConfig: MindfulAnchorConfig = {
  mode: 'mindful_anchor',
  instruction: 'Step outside and rest a bare palm on the grass.',
  min_duration_seconds: 120,
  options: [
    { key: 'grass', label: 'Grass', description: 'A lawn, a field, a verge.' },
    { key: 'soil', label: 'Soil' },
  ],
  require_option_choice: true,
};

const bareConfig: MindfulAnchorConfig = {
  mode: 'mindful_anchor',
  instruction: 'Take one slow, deliberate bite and notice every texture.',
  min_duration_seconds: 3,
  options: [],
  require_option_choice: false,
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MindfulAnchorView', () => {
  it('renders the instruction text', () => {
    const { getByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    expect(getByTestId('mindful-anchor-instruction')).toHaveTextContent(optionConfig.instruction);
  });

  it('renders the option chooser when options are configured and idle', () => {
    const { getByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    expect(getByTestId('mindful-anchor-options')).toBeTruthy();
    expect(getByTestId('mindful-anchor-option-grass')).toBeTruthy();
    expect(getByTestId('mindful-anchor-option-soil')).toBeTruthy();
  });

  it('hides the option chooser when no options are configured', () => {
    const { queryByTestId } = render(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    expect(queryByTestId('mindful-anchor-options')).toBeNull();
  });

  it('hides the option chooser once the session is running', () => {
    const { queryByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    expect(queryByTestId('mindful-anchor-options')).toBeNull();
  });

  it('disables Begin while a required choice is unmade', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    const begin = getByTestId('mindful-anchor-begin');
    expect(begin.props.accessibilityState).toEqual({ disabled: true });
    fireEvent.press(begin);
    expect(controls.start).not.toHaveBeenCalled();
  });

  it('enables Begin after an option is tapped', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    fireEvent.press(getByTestId('mindful-anchor-option-grass'));
    const begin = getByTestId('mindful-anchor-begin');
    expect(begin.props.accessibilityState).toEqual({ disabled: false });
    expect(getByTestId('mindful-anchor-option-grass').props.accessibilityState).toEqual({
      selected: true,
    });
    fireEvent.press(begin);
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('enables Begin immediately when no choice is required', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'idle' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    const begin = getByTestId('mindful-anchor-begin');
    expect(begin.props.accessibilityState).toEqual({ disabled: false });
    fireEvent.press(begin);
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('shows the elapsed-time display only while running', () => {
    const { queryByTestId, rerender } = render(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    expect(queryByTestId('mindful-anchor-elapsed')).toBeNull();
    rerender(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    expect(queryByTestId('mindful-anchor-elapsed')).toBeTruthy();
  });

  it('ticks the elapsed counter once per second and announces it politely', () => {
    const { getByTestId } = render(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    const elapsed = getByTestId('mindful-anchor-elapsed');
    expect(elapsed.props.accessibilityLiveRegion).toBe('polite');
    expect(getByTestId('mindful-anchor-elapsed-time').props.children).toBe('00:00');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(getByTestId('mindful-anchor-elapsed-time').props.children).toBe('00:03');
  });

  it('pops the soft confirm dialog when saving below the minimum duration', () => {
    const onComplete = jest.fn();
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={onComplete}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    fireEvent.press(getByTestId('mindful-anchor-save'));
    expect(getByTestId('mindful-anchor-confirm')).toBeTruthy();
    expect(getByTestId('mindful-anchor-confirm-message')).toHaveTextContent(
      /only spent 5 seconds here/,
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(controls.complete).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('mindful-anchor-confirm-save'));
    expect(queryByTestId('mindful-anchor-confirm')).toBeNull();
    expect(controls.complete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'mindful_anchor',
      chosen_option_key: null,
      duration_seconds: 5,
      met_min_duration: false,
    });
  });

  it('uses the singular noun when only one second elapsed', () => {
    const { getByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
        onComplete={jest.fn()}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    fireEvent.press(getByTestId('mindful-anchor-save'));
    expect(getByTestId('mindful-anchor-confirm-message')).toHaveTextContent(
      /only spent 1 second here/,
    );
  });

  it('returns to the running session when the confirm dialog is dismissed', () => {
    const onComplete = jest.fn();
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={onComplete}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    fireEvent.press(getByTestId('mindful-anchor-save'));
    fireEvent.press(getByTestId('mindful-anchor-confirm-cancel'));
    expect(queryByTestId('mindful-anchor-confirm')).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    expect(controls.complete).not.toHaveBeenCalled();
  });

  it('saves directly without a dialog once the minimum duration is met', () => {
    const onComplete = jest.fn();
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={onComplete}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    fireEvent.press(getByTestId('mindful-anchor-save'));
    expect(queryByTestId('mindful-anchor-confirm')).toBeNull();
    expect(controls.complete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'mindful_anchor',
      chosen_option_key: null,
      duration_seconds: 5,
      met_min_duration: true,
    });
  });

  it('carries the chosen option key into the saved metadata', () => {
    const onComplete = jest.fn();
    const controls = fakeControls();
    const { getByTestId, rerender } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={controls}
        onComplete={onComplete}
      />,
    );
    fireEvent.press(getByTestId('mindful-anchor-option-soil'));
    rerender(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={onComplete}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(125000);
    });
    fireEvent.press(getByTestId('mindful-anchor-save'));
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'mindful_anchor',
      chosen_option_key: 'soil',
      duration_seconds: 125,
      met_min_duration: true,
    });
  });

  it('clears local state when the engine returns to idle', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId, rerender } = render(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    fireEvent.press(getByTestId('mindful-anchor-option-grass'));
    rerender(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    rerender(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'idle' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    expect(getByTestId('mindful-anchor-option-grass').props.accessibilityState).toEqual({
      selected: false,
    });
    expect(getByTestId('mindful-anchor-begin').props.accessibilityState).toEqual({
      disabled: true,
    });
    rerender(
      <MindfulAnchorView
        config={optionConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    expect(getByTestId('mindful-anchor-elapsed-time').props.children).toBe('00:00');
    expect(queryByTestId('mindful-anchor-confirm')).toBeNull();
  });

  it('reuses RitualControlsBar for the non-idle engine states', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId, rerender } = render(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    fireEvent.press(getByTestId('ritual-pause'));
    expect(controls.pause).toHaveBeenCalledTimes(1);
    rerender(
      <MindfulAnchorView
        config={bareConfig}
        state={fakeState({ status: 'complete' })}
        controls={controls}
        onComplete={jest.fn()}
      />,
    );
    expect(getByTestId('ritual-complete-label')).toBeTruthy();
    expect(queryByTestId('mindful-anchor-save')).toBeNull();
    expect(queryByTestId('mindful-anchor-elapsed')).toBeNull();
  });

  it('saves immediately without a dialog when min_duration_seconds is zero', () => {
    const onComplete = jest.fn();
    const controls = fakeControls();
    const zeroConfig: MindfulAnchorConfig = { ...bareConfig, min_duration_seconds: 0 };
    const { getByTestId, queryByTestId } = render(
      <MindfulAnchorView
        config={zeroConfig}
        state={fakeState({ status: 'running' })}
        controls={controls}
        onComplete={onComplete}
      />,
    );
    fireEvent.press(getByTestId('mindful-anchor-save'));
    expect(queryByTestId('mindful-anchor-confirm')).toBeNull();
    expect(controls.complete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'mindful_anchor',
      chosen_option_key: null,
      duration_seconds: 0,
      met_min_duration: true,
    });
  });
});
