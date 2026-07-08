import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { CardMeditationCard, CardMeditationConfig } from '../../../engine/types';
import { CARD_MEDITATION_CARDS_MAX } from '../../../engine/types';
import { pickCardPhoto } from '../../../utils/pickCardPhoto';
import CardMeditationForm from '../CardMeditationForm';

jest.mock('../../../utils/pickCardPhoto', () => ({
  pickCardPhoto: jest.fn(),
}));

const mockPickCardPhoto = jest.mocked(pickCardPhoto);

function bundled(over: Partial<CardMeditationConfig> = {}): CardMeditationConfig {
  return { mode: 'card_meditation', deck_id: 'rws', cards: null, ...over };
}

function custom(cards: readonly CardMeditationCard[]): CardMeditationConfig {
  return { mode: 'card_meditation', deck_id: 'custom', cards };
}

const EMPTY_CARD: CardMeditationCard = {
  name: '',
  image_asset_key: null,
  image_uri: null,
  symbolism: null,
};

describe('CardMeditationForm — deck picker', () => {
  it('renders the three deck options', () => {
    const { getByTestId } = render(<CardMeditationForm value={bundled()} onChange={jest.fn()} />);
    expect(getByTestId('card-meditation-deck-major_arcana_text')).toBeTruthy();
    expect(getByTestId('card-meditation-deck-rws')).toBeTruthy();
    expect(getByTestId('card-meditation-deck-custom')).toBeTruthy();
  });

  it('switches to the custom deck with an empty card list', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<CardMeditationForm value={bundled()} onChange={onChange} />);
    fireEvent.press(getByTestId('card-meditation-deck-custom'));
    expect(onChange).toHaveBeenCalledWith({ ...bundled(), deck_id: 'custom', cards: [] });
  });

  it('clears the custom cards when switching back to a bundled deck', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <CardMeditationForm value={custom([EMPTY_CARD])} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('card-meditation-deck-major_arcana_text'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'card_meditation',
      deck_id: 'major_arcana_text',
      cards: null,
    });
  });

  it('does nothing when the already-selected deck is pressed', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<CardMeditationForm value={bundled()} onChange={onChange} />);
    fireEvent.press(getByTestId('card-meditation-deck-rws'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CardMeditationForm — bundled deck summary', () => {
  it('shows the card count and a cover image for an image deck', () => {
    const { getByTestId } = render(<CardMeditationForm value={bundled()} onChange={jest.fn()} />);
    expect(getByTestId('card-meditation-deck-count').props.children).toBe('78 cards');
    expect(getByTestId('card-meditation-deck-cover')).toBeTruthy();
  });

  it('omits the cover for the text-only deck', () => {
    const { queryByTestId } = render(
      <CardMeditationForm value={bundled({ deck_id: 'major_arcana_text' })} onChange={jest.fn()} />,
    );
    expect(queryByTestId('card-meditation-deck-cover')).toBeNull();
  });

  it('reports an unavailable deck gracefully', () => {
    const { getByTestId, getByText } = render(
      <CardMeditationForm value={bundled({ deck_id: 'retired_deck' })} onChange={jest.fn()} />,
    );
    expect(getByTestId('card-meditation-deck-summary')).toBeTruthy();
    expect(getByText('This deck is no longer available.')).toBeTruthy();
  });
});

describe('CardMeditationForm — custom card editor', () => {
  it('shows the empty state when a custom deck has no cards', () => {
    const { getByTestId } = render(<CardMeditationForm value={custom([])} onChange={jest.fn()} />);
    expect(getByTestId('card-meditation-empty')).toBeTruthy();
    expect(getByTestId('card-meditation-photo-note')).toBeTruthy();
  });

  it('adds a card', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<CardMeditationForm value={custom([])} onChange={onChange} />);
    fireEvent.press(getByTestId('card-meditation-add-card'));
    expect(onChange).toHaveBeenCalledWith(custom([EMPTY_CARD]));
  });

  it('removes a card', () => {
    const onChange = jest.fn();
    const card: CardMeditationCard = { ...EMPTY_CARD, name: 'Keep me' };
    const { getByTestId } = render(
      <CardMeditationForm value={custom([EMPTY_CARD, card])} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('card-meditation-remove-card-0'));
    expect(onChange).toHaveBeenCalledWith(custom([card]));
  });

  it('shows the surviving card values in their rows after card 0 is removed', () => {
    const alpha: CardMeditationCard = { ...EMPTY_CARD, name: 'Alpha' };
    const beta: CardMeditationCard = { ...EMPTY_CARD, name: 'Beta' };
    const onChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <CardMeditationForm value={custom([alpha, beta])} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('card-meditation-remove-card-0'));
    // The rows are fully controlled, so re-rendering with the filtered list
    // pulls each row's value straight from props — no stale index-key state.
    rerender(<CardMeditationForm value={custom([beta])} onChange={onChange} />);
    expect(getByTestId('card-meditation-card-name-0').props.value).toBe('Beta');
    expect(queryByTestId('card-meditation-card-name-1')).toBeNull();
  });

  it('edits a card name and symbolism', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <CardMeditationForm value={custom([EMPTY_CARD])} onChange={onChange} />,
    );
    fireEvent.changeText(getByTestId('card-meditation-card-name-0'), 'Sunrise');
    expect(onChange).toHaveBeenCalledWith(custom([{ ...EMPTY_CARD, name: 'Sunrise' }]));
    fireEvent.changeText(getByTestId('card-meditation-card-symbolism-0'), 'a new day');
    expect(onChange).toHaveBeenCalledWith(custom([{ ...EMPTY_CARD, symbolism: 'a new day' }]));
  });

  it('clears symbolism back to null when emptied', () => {
    const onChange = jest.fn();
    const card: CardMeditationCard = { ...EMPTY_CARD, symbolism: 'something' };
    const { getByTestId } = render(
      <CardMeditationForm value={custom([card])} onChange={onChange} />,
    );
    fireEvent.changeText(getByTestId('card-meditation-card-symbolism-0'), '');
    expect(onChange).toHaveBeenCalledWith(custom([{ ...card, symbolism: null }]));
  });

  it('stores a picked photo uri on the card', async () => {
    mockPickCardPhoto.mockResolvedValueOnce({ uri: 'file:///new.jpg' });
    const onChange = jest.fn();
    const { getByTestId } = render(
      <CardMeditationForm value={custom([EMPTY_CARD])} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('card-meditation-choose-photo-0'));
    expect(mockPickCardPhoto).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        custom([{ ...EMPTY_CARD, image_uri: 'file:///new.jpg', image_asset_key: null }]),
      ),
    );
  });

  it('leaves the card unchanged when the photo picker is dismissed', async () => {
    mockPickCardPhoto.mockResolvedValueOnce(null);
    const onChange = jest.fn();
    const { getByTestId } = render(
      <CardMeditationForm value={custom([EMPTY_CARD])} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('card-meditation-choose-photo-0'));
    await waitFor(() => expect(mockPickCardPhoto).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives a photo-picker failure without crashing or updating the card', async () => {
    mockPickCardPhoto.mockRejectedValueOnce(new Error('native module unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onChange = jest.fn();
    const { getByTestId } = render(
      <CardMeditationForm value={custom([EMPTY_CARD])} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('card-meditation-choose-photo-0'));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('renders a thumbnail for a card that already has a photo', () => {
    const card: CardMeditationCard = { ...EMPTY_CARD, image_uri: 'file:///saved.jpg' };
    const { getByTestId } = render(
      <CardMeditationForm value={custom([card])} onChange={jest.fn()} />,
    );
    expect(getByTestId('card-meditation-photo-thumb-0').props.source).toEqual({
      uri: 'file:///saved.jpg',
    });
  });
});

describe('CardMeditationForm — advanced section', () => {
  it('keeps the advanced fields collapsed until toggled', () => {
    const { getByTestId, queryByTestId } = render(
      <CardMeditationForm value={bundled()} onChange={jest.fn()} />,
    );
    expect(queryByTestId('card-meditation-advanced-fields')).toBeNull();
    fireEvent.press(getByTestId('card-meditation-advanced-toggle'));
    expect(getByTestId('card-meditation-advanced-fields')).toBeTruthy();
  });

  it('edits the per-card minutes and behaviour toggles', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<CardMeditationForm value={bundled()} onChange={onChange} />);
    fireEvent.press(getByTestId('card-meditation-advanced-toggle'));
    fireEvent.changeText(getByTestId('card-meditation-per-card'), '8');
    expect(onChange).toHaveBeenCalledWith({ ...bundled(), per_card_minutes: 8 });
    fireEvent(getByTestId('card-meditation-shuffle'), 'valueChange', false);
    expect(onChange).toHaveBeenCalledWith({ ...bundled(), shuffle: false });
    fireEvent(getByTestId('card-meditation-reveal'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledWith({ ...bundled(), reveal_after_meditation: true });
    fireEvent(getByTestId('card-meditation-hide-timer'), 'valueChange', false);
    expect(onChange).toHaveBeenCalledWith({ ...bundled(), hide_timer_during_meditation: false });
  });

  it('restores the default per-card minutes when the field is cleared', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<CardMeditationForm value={bundled()} onChange={onChange} />);
    fireEvent.press(getByTestId('card-meditation-advanced-toggle'));
    fireEvent.changeText(getByTestId('card-meditation-per-card'), '');
    expect(onChange).toHaveBeenCalledWith({ ...bundled(), per_card_minutes: 5 });
  });
});

describe('CardMeditationForm — card cap', () => {
  it('hides the add-card button once the deck reaches CARD_MEDITATION_CARDS_MAX', () => {
    const atMax = Array.from({ length: CARD_MEDITATION_CARDS_MAX }, () => EMPTY_CARD);
    const { queryByTestId } = render(
      <CardMeditationForm value={custom(atMax)} onChange={jest.fn()} />,
    );
    expect(queryByTestId('card-meditation-add-card')).toBeNull();
  });

  it('still offers the add-card button one below the cap', () => {
    const belowMax = Array.from({ length: CARD_MEDITATION_CARDS_MAX - 1 }, () => EMPTY_CARD);
    const { getByTestId } = render(
      <CardMeditationForm value={custom(belowMax)} onChange={jest.fn()} />,
    );
    expect(getByTestId('card-meditation-add-card')).toBeTruthy();
  });
});
