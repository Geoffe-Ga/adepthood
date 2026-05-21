import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { CardMeditationCard, CardMeditationConfig } from '../../engine/types';
import CardMeditationView from '../CardMeditationView';

import { fakeControls, fakeState } from './fixtures';

function config(over: Partial<CardMeditationConfig> = {}): CardMeditationConfig {
  return { mode: 'card_meditation', deck_id: 'rws', cards: null, shuffle: false, ...over };
}

function customConfig(card: CardMeditationCard): CardMeditationConfig {
  return config({ deck_id: 'custom', cards: [card], shuffle: false });
}

const PHOTO_CARD: CardMeditationCard = {
  name: 'Photo Card',
  image_asset_key: null,
  image_uri: 'file:///photo.jpg',
  symbolism: 'a remembered place',
};

const TEXT_CARD: CardMeditationCard = {
  name: 'Text Card',
  image_asset_key: null,
  image_uri: null,
  symbolism: 'meaning without a picture',
};

describe('CardMeditationView', () => {
  it('renders a bundled deck card with its image', () => {
    const { getByTestId } = render(
      <CardMeditationView config={config()} state={fakeState()} controls={fakeControls()} />,
    );
    expect(getByTestId('card-meditation-card-image')).toBeTruthy();
    expect(getByTestId('card-meditation-card-name').props.children).toBeTruthy();
  });

  it('renders a custom card from its device image_uri', () => {
    const { getByTestId } = render(
      <CardMeditationView
        config={customConfig(PHOTO_CARD)}
        state={fakeState()}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-card-image').props.source).toEqual({
      uri: 'file:///photo.jpg',
    });
    expect(getByTestId('card-meditation-card-name').props.children).toBe('Photo Card');
  });

  it('falls back to text when both image fields are missing', () => {
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={customConfig(TEXT_CARD)}
        state={fakeState()}
        controls={fakeControls()}
      />,
    );
    expect(queryByTestId('card-meditation-card-image')).toBeNull();
    expect(getByTestId('card-meditation-card-name').props.children).toBe('Text Card');
    expect(getByTestId('card-meditation-card-symbolism').props.children).toBe(
      'meaning without a picture',
    );
  });

  it('falls back to text when a device image_uri no longer resolves', () => {
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={customConfig(PHOTO_CARD)}
        state={fakeState()}
        controls={fakeControls()}
      />,
    );
    fireEvent(getByTestId('card-meditation-card-image'), 'error');
    expect(queryByTestId('card-meditation-card-image')).toBeNull();
    expect(getByTestId('card-meditation-card-name').props.children).toBe('Photo Card');
  });

  it('hides the card behind a placeholder while running in the reveal flow', () => {
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={config({ reveal_after_meditation: true })}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-placeholder')).toBeTruthy();
    expect(queryByTestId('card-meditation-card')).toBeNull();
  });

  it('reveals the card at completion in the reveal flow', () => {
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={config({ reveal_after_meditation: true })}
        state={fakeState({ status: 'complete', remainingMs: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(queryByTestId('card-meditation-placeholder')).toBeNull();
    expect(getByTestId('card-meditation-card')).toBeTruthy();
  });

  it('shows the card from the start in the immediate flow', () => {
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={config({ reveal_after_meditation: false })}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-card')).toBeTruthy();
    expect(queryByTestId('card-meditation-placeholder')).toBeNull();
  });

  it('starts the engine from the idle Begin button', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <CardMeditationView
        config={config()}
        state={fakeState({ status: 'idle' })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('card-meditation-begin'));
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('renders an image card without symbolism', () => {
    const imageOnly: CardMeditationCard = {
      name: 'Untitled',
      image_asset_key: null,
      image_uri: 'file:///bare.jpg',
      symbolism: null,
    };
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={customConfig(imageOnly)}
        state={fakeState()}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-card-image').props.accessibilityLabel).toBe('Untitled');
    expect(queryByTestId('card-meditation-card-symbolism')).toBeNull();
  });

  it('keeps a bundled image visible if its image element reports an error', () => {
    const { getByTestId } = render(
      <CardMeditationView config={config()} state={fakeState()} controls={fakeControls()} />,
    );
    fireEvent(getByTestId('card-meditation-card-image'), 'error');
    expect(getByTestId('card-meditation-card-image')).toBeTruthy();
  });

  it('renders a 00:00 timer when no remaining time is supplied', () => {
    const { getByTestId } = render(
      <CardMeditationView
        config={config()}
        state={fakeState({ status: 'complete', remainingMs: null })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-time-remaining').props.children).toBe('00:00');
  });

  it('hides the timer while running when hide_timer_during_meditation is set', () => {
    const controls = fakeControls();
    const { getByTestId, queryByTestId } = render(
      <CardMeditationView
        config={config({ hide_timer_during_meditation: true })}
        state={fakeState({ status: 'running', remainingMs: 120_000 })}
        controls={controls}
      />,
    );
    expect(queryByTestId('card-meditation-time-remaining')).toBeNull();
    fireEvent(getByTestId('card-meditation-cancel-longpress'), 'longPress');
    expect(controls.cancel).toHaveBeenCalledTimes(1);
  });

  it('shows the timer and controls bar while running when the timer is not hidden', () => {
    const { getByTestId } = render(
      <CardMeditationView
        config={config({ hide_timer_during_meditation: false })}
        state={fakeState({ status: 'running', remainingMs: 90_000 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-time-remaining').props.children).toBe('01:30');
    expect(getByTestId('ritual-controls-bar')).toBeTruthy();
  });

  it('shows the timer and controls bar when paused', () => {
    const { getByTestId } = render(
      <CardMeditationView
        config={config()}
        state={fakeState({ status: 'paused', remainingMs: 60_000 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('card-meditation-time-remaining').props.children).toBe('01:00');
    expect(getByTestId('ritual-controls-bar')).toBeTruthy();
  });

  it('surfaces the standard controls bar on completion', () => {
    const { getByTestId } = render(
      <CardMeditationView
        config={config()}
        state={fakeState({ status: 'complete', remainingMs: 0 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('ritual-controls-bar')).toBeTruthy();
    expect(getByTestId('ritual-complete-label')).toBeTruthy();
  });
});
