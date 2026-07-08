import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import type { EngineStatus } from '../../engine/types';
import RitualControlsBar from '../RitualControlsBar';

import { fakeControls } from './fixtures';

const STATUS_CONTROL_MATRIX: readonly {
  status: EngineStatus;
  present: readonly string[];
  absent: readonly string[];
}[] = [
  {
    status: 'idle',
    present: ['ritual-start'],
    absent: ['ritual-pause', 'ritual-resume', 'ritual-cancel', 'ritual-complete-label'],
  },
  {
    status: 'running',
    present: ['ritual-pause', 'ritual-cancel'],
    absent: ['ritual-start', 'ritual-resume', 'ritual-complete-label'],
  },
  {
    status: 'paused',
    present: ['ritual-resume', 'ritual-cancel'],
    absent: ['ritual-start', 'ritual-pause', 'ritual-complete-label'],
  },
  {
    status: 'complete',
    present: ['ritual-complete-label'],
    absent: ['ritual-start', 'ritual-pause', 'ritual-resume', 'ritual-cancel'],
  },
];

describe('RitualControlsBar', () => {
  it('renders Start only when idle and calls controls.start on press', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <RitualControlsBar status="idle" controls={controls} />,
    );
    fireEvent.press(getByTestId('ritual-start'));
    expect(controls.start).toHaveBeenCalledTimes(1);
    expect(queryByTestId('ritual-pause')).toBeNull();
    expect(queryByTestId('ritual-resume')).toBeNull();
  });

  it('renders Pause + Cancel when running and wires both callbacks', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <RitualControlsBar status="running" controls={controls} />,
    );
    fireEvent.press(getByTestId('ritual-pause'));
    fireEvent.press(getByTestId('ritual-cancel'));
    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(controls.cancel).toHaveBeenCalledTimes(1);
    expect(queryByTestId('ritual-start')).toBeNull();
  });

  it('renders Resume + Cancel when paused', () => {
    const controls = fakeControls();
    const { getByTestId } = render(<RitualControlsBar status="paused" controls={controls} />);
    fireEvent.press(getByTestId('ritual-resume'));
    expect(controls.resume).toHaveBeenCalledTimes(1);
  });

  it('renders the complete label without action buttons when status is complete', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <RitualControlsBar status="complete" controls={controls} />,
    );
    expect(getByTestId('ritual-complete-label')).toBeTruthy();
    expect(queryByTestId('ritual-start')).toBeNull();
    expect(queryByTestId('ritual-cancel')).toBeNull();
  });

  it('plays the completion Celebration around the complete label', () => {
    const controls = fakeControls();
    const { getByTestId } = render(<RitualControlsBar status="complete" controls={controls} />);
    const celebration = getByTestId('ritual-complete-celebration');
    expect(celebration).toBeTruthy();
    // The label is rendered inside the celebration wrapper, not bare.
    expect(within(celebration).getByTestId('ritual-complete-label')).toBeTruthy();
  });

  it('honours the optional startLabel override on the start button', () => {
    const controls = fakeControls();
    const { getByText } = render(
      <RitualControlsBar status="idle" controls={controls} startLabel="Begin" />,
    );
    expect(getByText('Begin')).toBeTruthy();
  });

  it.each(STATUS_CONTROL_MATRIX)(
    'renders exactly the right controls for status $status',
    ({ status, present, absent }) => {
      const controls = fakeControls();
      const { getByTestId, queryByTestId } = render(
        <RitualControlsBar status={status} controls={controls} />,
      );
      for (const id of present) expect(getByTestId(id)).toBeTruthy();
      for (const id of absent) expect(queryByTestId(id)).toBeNull();
    },
  );
});
