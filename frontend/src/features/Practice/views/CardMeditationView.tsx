import React, { useState } from 'react';
import type { ImageSourcePropType } from 'react-native';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { resolveCardImage } from '../data/assetResolver';
import type { PickedCard } from '../data/resolveCard';
import { pickCard } from '../data/resolveCard';
import type { CardMeditationCard, CardMeditationConfig } from '../engine/types';
import type { RitualControls, RitualState } from '../engine/types';

import { MeditationCardShell, SESSION_CARD_MAX_HEIGHT } from './shared';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/**
 * Single-card meditation view for the `card_meditation` mode.
 *
 * The card is drawn once at mount (`pickCard`) and held in local state so
 * a re-render never reshuffles. Two flows:
 *
 *   - **Reveal** (`reveal_after_meditation`): the card is hidden behind a
 *     placeholder while the engine runs and is revealed at completion, so
 *     the card meets the user unprimed.
 *   - **Immediate**: the card image fills the frame from the start.
 *
 * The timer is hidden while running when `hide_timer_during_meditation`
 * is set; pausing brings it back as an honesty-over-purism escape hatch.
 * Saving is handled by the parent's post-completion insight modal — the
 * complete state here just surfaces the standard controls bar.
 */
interface Props {
  config: CardMeditationConfig;
  state: RitualState;
  controls: RitualControls;
  /**
   * The drawn card, resolved once by the parent so the view and the
   * harvested session metadata never describe different cards. `null` /
   * omitted only in isolation tests, where the view draws its own card.
   */
  picked?: PickedCard | null;
}

const PLACEHOLDER_COPY = 'Sit. The card will be revealed when the timer ends.';

const CardMeditationView = ({
  config,
  state,
  controls,
  picked: pickedProp,
}: Props): React.JSX.Element => {
  const [picked] = useState<PickedCard>(() => pickedProp ?? pickCard(config));
  const reveal = config.reveal_after_meditation ?? false;
  const hideTimer = config.hide_timer_during_meditation ?? true;
  const showCard = !reveal || state.status === 'complete';
  return (
    <MeditationCardShell
      state={state}
      controls={controls}
      hideTimer={hideTimer}
      face={showCard ? <CardFace card={picked.card} /> : <RevealPlaceholder />}
      testIDs={{
        view: 'card-meditation-view',
        timer: 'card-meditation-time-remaining',
        begin: 'card-meditation-begin',
        cancelLongpress: 'card-meditation-cancel-longpress',
      }}
    />
  );
};

const RevealPlaceholder = (): React.JSX.Element => (
  <View style={styles.card} testID="card-meditation-placeholder">
    <Text style={styles.placeholderText}>{PLACEHOLDER_COPY}</Text>
  </View>
);

const CardFace = ({ card }: { card: CardMeditationCard }): React.JSX.Element => {
  // A device-local `image_uri` may no longer resolve (the user deleted the
  // photo); `uriError` then drops to the bundled asset or text rendering
  // instead of crashing on a broken source.
  const [uriError, setUriError] = useState(false);
  const deviceSource: ImageSourcePropType | null =
    card.image_uri !== null && !uriError ? { uri: card.image_uri } : null;
  const assetSource = card.image_asset_key !== null ? resolveCardImage(card.image_asset_key) : null;
  const imageSource: ImageSourcePropType | null = deviceSource ?? assetSource;
  const altText = card.symbolism !== null && card.symbolism.length > 0 ? card.symbolism : card.name;
  return (
    <View
      style={styles.card}
      testID="card-meditation-card"
      accessibilityLabel={`Card: ${card.name}`}
    >
      {imageSource !== null && (
        <Image
          source={imageSource}
          style={styles.cardImage}
          resizeMode="contain"
          testID="card-meditation-card-image"
          accessibilityLabel={altText}
          onError={() => {
            if (deviceSource !== null) setUriError(true);
          }}
        />
      )}
      <Text
        style={styles.cardName}
        numberOfLines={1}
        adjustsFontSizeToFit
        testID="card-meditation-card-name"
      >
        {card.name}
      </Text>
      {card.symbolism !== null && card.symbolism.length > 0 && (
        <ScrollView style={styles.symbolismScroll}>
          <Text style={styles.cardSymbolism} testID="card-meditation-card-symbolism">
            {card.symbolism}
          </Text>
        </ScrollView>
      )}
    </View>
  );
};

const CARD_WIDTH = 280;
const CARD_MIN_HEIGHT = 380;
const CARD_IMAGE_HEIGHT = 280;
/** Generous dark frame around the artwork — lowers visual noise during the sit. */
const CARD_BORDER_WIDTH = 8;
/** Symbolism scroll cap — the artwork leaves little card height below it. */
export const SYMBOLISM_MAX_HEIGHT = 96;

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    minHeight: CARD_MIN_HEIGHT,
    maxHeight: SESSION_CARD_MAX_HEIGHT,
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.xl,
    borderWidth: CARD_BORDER_WIDTH,
    borderColor: colors.primary,
    padding: SPACING.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xl,
    ...shadows.medium,
  },
  cardImage: {
    width: CARD_WIDTH - SPACING.lg * 2,
    height: CARD_IMAGE_HEIGHT,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.md,
  },
  cardName: {
    fontSize: 24,
    fontWeight: '600',
    color: colors.text.light,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  symbolismScroll: { maxHeight: SYMBOLISM_MAX_HEIGHT, flexShrink: 1 },
  cardSymbolism: {
    fontSize: 13,
    color: colors.text.light,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: SPACING.sm,
    opacity: 0.85,
  },
  placeholderText: {
    fontSize: 16,
    color: colors.text.light,
    textAlign: 'center',
    lineHeight: 24,
    paddingHorizontal: SPACING.lg,
  },
});

export default CardMeditationView;
