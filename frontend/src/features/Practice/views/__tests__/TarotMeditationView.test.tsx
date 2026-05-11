import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { MAJOR_ARCANA } from '../../data/tarot';
import TarotMeditationView from '../TarotMeditationView';

import { fakeControls, fakeState } from './fixtures';

const FOOL = MAJOR_ARCANA[0]!;

describe('TarotMeditationView', () => {
  it('renders the card name, keyword, and a Begin button while idle', () => {
    const controls = fakeControls();
    const { getByTestId, getByText } = render(
      <TarotMeditationView
        state={fakeState({ status: 'idle' })}
        controls={controls}
        card={FOOL}
        hideTimer
      />,
    );
    expect(getByTestId('tarot-card-name').props.children).toBe(FOOL.name);
    expect(getByText(FOOL.keyword)).toBeTruthy();
    fireEvent.press(getByTestId('tarot-begin'));
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('hides the timer and controls bar while running with hideTimer=true', () => {
    const { queryByTestId, getByTestId, getByText } = render(
      <TarotMeditationView
        state={fakeState({ status: 'running', remainingMs: 270_000 })}
        controls={fakeControls()}
        card={FOOL}
        hideTimer
      />,
    );
    expect(queryByTestId('tarot-time-remaining')).toBeNull();
    expect(queryByTestId('ritual-controls-bar')).toBeNull();
    // Card content stays visible.
    expect(getByTestId('tarot-card-name').props.children).toBe(FOOL.name);
    expect(getByText(FOOL.keyword)).toBeTruthy();
    // Long-press cancel exists as the only exit.
    expect(getByTestId('tarot-cancel-longpress')).toBeTruthy();
  });

  it('shows the timer while running when hideTimer=false (escape hatch off)', () => {
    const { getByTestId } = render(
      <TarotMeditationView
        state={fakeState({ status: 'running', remainingMs: 90_000 })}
        controls={fakeControls()}
        card={FOOL}
        hideTimer={false}
      />,
    );
    expect(getByTestId('tarot-time-remaining').props.children).toBe('01:30');
  });

  it('never renders mm:ss text while running with hideTimer=true', () => {
    const { queryByText } = render(
      <TarotMeditationView
        state={fakeState({ status: 'running', remainingMs: 305_000 })}
        controls={fakeControls()}
        card={FOOL}
        hideTimer
      />,
    );
    // Match any mm:ss substring; the card metadata never uses ":" so this
    // catches an accidental leak of the timer string.
    expect(queryByText(/\d{2}:\d{2}/)).toBeNull();
  });

  it('cancels the session when the long-press affordance fires', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <TarotMeditationView
        state={fakeState({ status: 'running' })}
        controls={controls}
        card={FOOL}
        hideTimer
      />,
    );
    fireEvent(getByTestId('tarot-cancel-longpress'), 'longPress');
    expect(controls.cancel).toHaveBeenCalledTimes(1);
  });

  it('shows the timer and standard controls when paused', () => {
    const { getByTestId } = render(
      <TarotMeditationView
        state={fakeState({ status: 'paused', remainingMs: 180_000 })}
        controls={fakeControls()}
        card={FOOL}
        hideTimer
      />,
    );
    expect(getByTestId('tarot-time-remaining').props.children).toBe('03:00');
    expect(getByTestId('ritual-controls-bar')).toBeTruthy();
    expect(getByTestId('ritual-resume')).toBeTruthy();
  });

  it('reveals the timer reading and a Save CTA when complete', () => {
    const onSave = jest.fn();
    const { getByTestId } = render(
      <TarotMeditationView
        state={fakeState({ status: 'complete', elapsedMs: 300_000, remainingMs: 0 })}
        controls={fakeControls()}
        card={FOOL}
        hideTimer
        onSave={onSave}
      />,
    );
    expect(getByTestId('tarot-time-remaining').props.children).toBe('00:00');
    fireEvent.press(getByTestId('tarot-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('disables the Save CTA and dims it when onSave is omitted', () => {
    const { getByTestId } = render(
      <TarotMeditationView
        state={fakeState({ status: 'complete', remainingMs: 0 })}
        controls={fakeControls()}
        card={FOOL}
        hideTimer
      />,
    );
    const save = getByTestId('tarot-save');
    expect(save.props.accessibilityState).toEqual({ disabled: true });
    const flattened = Array.isArray(save.props.style)
      ? Object.assign({}, ...save.props.style.filter(Boolean))
      : save.props.style;
    expect(flattened.opacity).toBe(0.5);
  });

  it('renders the card name and keyword in every status', () => {
    const statuses = ['idle', 'running', 'paused', 'complete'] as const;
    for (const status of statuses) {
      const { getByTestId, getByText, unmount } = render(
        <TarotMeditationView
          state={fakeState({ status, remainingMs: 60_000 })}
          controls={fakeControls()}
          card={FOOL}
          hideTimer
        />,
      );
      expect(getByTestId('tarot-card-name').props.children).toBe(FOOL.name);
      expect(getByText(FOOL.keyword)).toBeTruthy();
      unmount();
    }
  });
});
