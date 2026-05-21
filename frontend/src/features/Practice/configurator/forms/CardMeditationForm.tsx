import React, { useRef, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { resolveCardImage } from '../../data/assetResolver';
import type { DeckMeta } from '../../data/decks';
import { BUNDLED_DECKS, getDeck } from '../../data/decks';
import type { CardMeditationCard, CardMeditationConfig } from '../../engine/types';
import {
  CARD_MEDITATION_CARDS_MAX,
  CARD_MEDITATION_CUSTOM_DECK_ID,
  CARD_MEDITATION_NAME_MAX,
  CARD_MEDITATION_SYMBOLISM_MAX,
  DEFAULT_CARD_MEDITATION_MINUTES,
} from '../../engine/types';
import { pickCardPhoto } from '../../utils/pickCardPhoto';

import { Chip, LabeledRow, NumericField, TextField, ToggleRow } from './shared';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

interface Props {
  value: CardMeditationConfig;
  onChange: (next: CardMeditationConfig) => void;
}

const PHOTO_NOTE =
  'Photos are kept on this device. If you delete the photo, the card falls back to its name.';

const EMPTY_CARD: CardMeditationCard = {
  name: '',
  image_asset_key: null,
  image_uri: null,
  symbolism: null,
};

const CardMeditationForm = ({ value, onChange }: Props): React.JSX.Element => {
  const isCustom = value.deck_id === CARD_MEDITATION_CUSTOM_DECK_ID;
  return (
    <View testID="card-meditation-form">
      <DeckPicker value={value} onChange={onChange} />
      {isCustom ? (
        <CustomCardEditor value={value} onChange={onChange} />
      ) : (
        <DeckSummary deckId={value.deck_id} />
      )}
      <AdvancedSection value={value} onChange={onChange} />
    </View>
  );
};

const DeckPicker = ({ value, onChange }: Props): React.JSX.Element => {
  const selectDeck = (deckId: string) => {
    if (deckId === value.deck_id) return;
    onChange(
      deckId === CARD_MEDITATION_CUSTOM_DECK_ID
        ? { ...value, deck_id: deckId, cards: value.cards ?? [] }
        : { ...value, deck_id: deckId, cards: null },
    );
  };
  return (
    <View testID="card-meditation-deck-picker">
      <Text style={styles.sectionTitle}>Deck</Text>
      <View style={styles.deckRow}>
        {BUNDLED_DECKS.map((deck) => (
          <Chip
            key={deck.id}
            label={deck.name}
            active={value.deck_id === deck.id}
            onPress={() => selectDeck(deck.id)}
            testID={`card-meditation-deck-${deck.id}`}
          />
        ))}
        <Chip
          label="Custom"
          active={value.deck_id === CARD_MEDITATION_CUSTOM_DECK_ID}
          onPress={() => selectDeck(CARD_MEDITATION_CUSTOM_DECK_ID)}
          testID={`card-meditation-deck-${CARD_MEDITATION_CUSTOM_DECK_ID}`}
        />
      </View>
    </View>
  );
};

const DeckSummary = ({ deckId }: { deckId: string }): React.JSX.Element => {
  const deck = getDeck(deckId);
  if (!deck) {
    return (
      <View testID="card-meditation-deck-summary">
        <Text style={styles.unknownDeck}>This deck is no longer available.</Text>
      </View>
    );
  }
  return <KnownDeckSummary deck={deck} />;
};

const KnownDeckSummary = ({ deck }: { deck: DeckMeta }): React.JSX.Element => {
  const cover = deck.cards.length > 0 ? resolveCardImage(deck.cards[0]?.asset_key ?? null) : null;
  return (
    <View style={styles.summary} testID="card-meditation-deck-summary">
      {cover !== null && (
        <Image
          source={cover}
          style={styles.cover}
          resizeMode="cover"
          testID="card-meditation-deck-cover"
        />
      )}
      <View style={styles.summaryText}>
        <Text style={styles.summaryName}>{deck.name}</Text>
        <Text style={styles.summaryCount} testID="card-meditation-deck-count">
          {`${deck.cards.length} cards`}
        </Text>
        <Text style={styles.summaryDescription}>{deck.description}</Text>
      </View>
    </View>
  );
};

// Monotonic source of per-row keys. Cards have no persistable id (the
// backend config schema is `extra="forbid"`), so row identity is tracked
// transiently here instead of on the card object.
let nextCardKey = 0;

const CustomCardEditor = ({ value, onChange }: Props): React.JSX.Element => {
  const cards = value.cards ?? [];
  // One stable key per row, kept in lockstep with add/remove so a non-tail
  // removal cannot shift a surviving row onto a different key (which would
  // let React reuse the wrong row instance).
  const keysRef = useRef<string[] | null>(null);
  keysRef.current ??= cards.map(() => `card-${(nextCardKey += 1)}`);
  const keys = keysRef.current;
  const setCards = (next: readonly CardMeditationCard[]) => onChange({ ...value, cards: next });
  const updateCard = (index: number, patch: Partial<CardMeditationCard>) =>
    setCards(cards.map((card, i) => (i === index ? { ...card, ...patch } : card)));
  const removeCard = (index: number) => {
    keysRef.current = keys.filter((_, i) => i !== index);
    setCards(cards.filter((_, i) => i !== index));
  };
  const addCard = () => {
    keysRef.current = [...keys, `card-${(nextCardKey += 1)}`];
    setCards([...cards, EMPTY_CARD]);
  };
  return (
    <View testID="card-meditation-card-editor">
      <Text style={styles.sectionTitle}>Your cards</Text>
      <Text style={styles.photoNote} testID="card-meditation-photo-note">
        {PHOTO_NOTE}
      </Text>
      {cards.length === 0 && (
        <Text style={styles.emptyState} testID="card-meditation-empty">
          Add at least one card to use this deck.
        </Text>
      )}
      {cards.map((card, index) => (
        <CardRow
          key={keys[index] ?? `card-fallback-${index}`}
          index={index}
          card={card}
          onUpdate={updateCard}
          onRemove={removeCard}
        />
      ))}
      {cards.length < CARD_MEDITATION_CARDS_MAX && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Add card"
          onPress={addCard}
          style={styles.addButton}
          testID="card-meditation-add-card"
        >
          <Text style={styles.addButtonText}>+ Add card</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

interface CardRowProps {
  index: number;
  card: CardMeditationCard;
  onUpdate: (index: number, patch: Partial<CardMeditationCard>) => void;
  onRemove: (index: number) => void;
}

const CardRow = ({ index, card, onUpdate, onRemove }: CardRowProps): React.JSX.Element => (
  <View style={styles.cardRow} testID={`card-meditation-card-row-${index}`}>
    <View style={styles.cardRowHeader}>
      <Text style={styles.cardRowLabel}>{`Card ${index + 1}`}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Remove card ${index + 1}`}
        onPress={() => onRemove(index)}
        testID={`card-meditation-remove-card-${index}`}
      >
        <Text style={styles.removeText}>Remove</Text>
      </TouchableOpacity>
    </View>
    <LabeledRow label="Name">
      <TextField
        value={card.name}
        onChange={(name) => onUpdate(index, { name })}
        placeholder="Card name"
        maxLength={CARD_MEDITATION_NAME_MAX}
        testID={`card-meditation-card-name-${index}`}
      />
    </LabeledRow>
    <CardPhotoField index={index} card={card} onUpdate={onUpdate} />
    <LabeledRow label="Symbolism">
      <TextField
        value={card.symbolism ?? ''}
        onChange={(text) => onUpdate(index, { symbolism: text.length > 0 ? text : null })}
        placeholder="Optional"
        maxLength={CARD_MEDITATION_SYMBOLISM_MAX}
        testID={`card-meditation-card-symbolism-${index}`}
      />
    </LabeledRow>
  </View>
);

interface CardPhotoFieldProps {
  index: number;
  card: CardMeditationCard;
  onUpdate: (index: number, patch: Partial<CardMeditationCard>) => void;
}

const CardPhotoField = ({ index, card, onUpdate }: CardPhotoFieldProps): React.JSX.Element => {
  const choosePhoto = async () => {
    try {
      const photo = await pickCardPhoto();
      if (photo) onUpdate(index, { image_uri: photo.uri, image_asset_key: null });
    } catch (error) {
      // A broken native build can reject the permission/picker call; keep the
      // form usable and leave a dev-only breadcrumb rather than crashing.
      if (__DEV__) console.warn('Card photo picker failed:', error);
    }
  };
  return (
    <View style={styles.photoRow}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Choose photo for card ${index + 1}`}
        onPress={() => {
          void choosePhoto();
        }}
        style={styles.photoButton}
        testID={`card-meditation-choose-photo-${index}`}
      >
        <Text style={styles.photoButtonText}>
          {card.image_uri !== null ? 'Change photo' : 'Choose photo'}
        </Text>
      </TouchableOpacity>
      {card.image_uri !== null && (
        <Image
          source={{ uri: card.image_uri }}
          style={styles.photoThumb}
          testID={`card-meditation-photo-thumb-${index}`}
        />
      )}
    </View>
  );
};

const AdvancedSection = ({ value, onChange }: Props): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <View testID="card-meditation-advanced">
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Advanced settings"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((prev) => !prev)}
        style={styles.advancedToggle}
        testID="card-meditation-advanced-toggle"
      >
        <Text style={styles.advancedToggleText}>{`${open ? '▾' : '▸'} Advanced`}</Text>
      </TouchableOpacity>
      {open && <AdvancedFields value={value} onChange={onChange} />}
    </View>
  );
};

const AdvancedFields = ({ value, onChange }: Props): React.JSX.Element => (
  <View testID="card-meditation-advanced-fields">
    <LabeledRow label="Minutes with the card">
      <NumericField
        value={value.per_card_minutes ?? DEFAULT_CARD_MEDITATION_MINUTES}
        onChange={(minutes) =>
          onChange({ ...value, per_card_minutes: minutes ?? DEFAULT_CARD_MEDITATION_MINUTES })
        }
        allowNull
        testID="card-meditation-per-card"
      />
    </LabeledRow>
    <ToggleRow
      label="Shuffle the deck"
      value={value.shuffle ?? true}
      onChange={(shuffle) => onChange({ ...value, shuffle })}
      testID="card-meditation-shuffle"
    />
    <ToggleRow
      label="Reveal card after the sit"
      value={value.reveal_after_meditation ?? false}
      onChange={(reveal_after_meditation) => onChange({ ...value, reveal_after_meditation })}
      testID="card-meditation-reveal"
    />
    <ToggleRow
      label="Hide timer during sit"
      value={value.hide_timer_during_meditation ?? true}
      onChange={(hide_timer_during_meditation) =>
        onChange({ ...value, hide_timer_during_meditation })
      }
      testID="card-meditation-hide-timer"
    />
  </View>
);

const COVER_SIZE = 64;
const THUMB_SIZE = 44;

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  deckRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  summary: {
    flexDirection: 'row',
    gap: SPACING.md,
    padding: SPACING.md,
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.md,
    marginTop: SPACING.sm,
  },
  summaryText: { flex: 1 },
  summaryName: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
  summaryCount: { fontSize: 13, color: colors.text.secondaryAccessible, marginTop: 2 },
  summaryDescription: {
    fontSize: 13,
    color: colors.text.secondaryAccessible,
    marginTop: SPACING.xs,
    lineHeight: 18,
  },
  cover: { width: COVER_SIZE, height: COVER_SIZE, borderRadius: BORDER_RADIUS.sm },
  unknownDeck: { fontSize: 14, color: colors.danger, marginTop: SPACING.sm },
  photoNote: {
    fontSize: 12,
    color: colors.text.secondaryAccessible,
    fontStyle: 'italic',
    marginBottom: SPACING.sm,
  },
  emptyState: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    paddingVertical: SPACING.md,
  },
  cardRow: {
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
  },
  cardRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardRowLabel: { fontSize: 13, fontWeight: '600', color: colors.text.primary },
  removeText: { fontSize: 13, color: colors.danger, fontWeight: '500' },
  photoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  photoButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
  },
  photoButtonText: { fontSize: 13, fontWeight: '500', color: colors.text.primary },
  photoThumb: { width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: BORDER_RADIUS.sm },
  addButton: {
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
  },
  addButtonText: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  advancedToggle: { paddingVertical: SPACING.md, marginTop: SPACING.sm },
  advancedToggleText: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
});

export default CardMeditationForm;
