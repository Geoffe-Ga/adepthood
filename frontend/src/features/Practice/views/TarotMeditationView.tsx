import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { TarotCard } from '../data/tarot';
import type { RitualControls, RitualState } from '../engine/types';

import type { SessionSurface } from './sessionSurface';
import { useSessionSurface } from './sessionSurface';
import { MeditationCardShell, SessionCtaButton } from './shared';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/**
 * Day-by-day major-arcana meditation view.
 *
 * Important contract: this view does not read the wall clock. The parent
 * (`PracticeScreen` in ritual-11) computes the day-of-practice from
 * `UserPractice.start_date` in the user's local timezone and passes the
 * resolved card down via `card`. Recomputing here would let timezone bugs
 * land in two places — keep it pinned to the parent.
 *
 * The timer is intentionally hidden during the meditative window when
 * `hideTimer` is true: the practice asks the user to sit with the card
 * for ~5 minutes without clock-watching. Pausing brings the timer back as
 * an "honesty over purism" escape hatch, and completion always reveals
 * the final reading alongside the post-session Save CTA.
 */
interface Props {
  state: RitualState;
  controls: RitualControls;
  card: TarotCard;
  /** When true, suppress the countdown while the engine is running. */
  hideTimer: boolean;
  /** Optional Save callback; the parent typically launches the insight modal. */
  onSave?: () => void;
}

const TarotMeditationView = ({
  state,
  controls,
  card,
  hideTimer,
  onSave,
}: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  return (
    <MeditationCardShell
      state={state}
      controls={controls}
      hideTimer={hideTimer}
      face={<TarotCardFace card={card} surface={surface} />}
      completeFooter={<TarotSaveButton onSave={onSave} />}
      testIDs={{
        view: 'tarot-meditation-view',
        timer: 'tarot-time-remaining',
        begin: 'tarot-begin',
        cancelLongpress: 'tarot-cancel-longpress',
      }}
    />
  );
};

interface TarotCardFaceProps {
  card: TarotCard;
  surface: SessionSurface;
}

const TarotCardFace = ({ card, surface }: TarotCardFaceProps): React.JSX.Element => (
  <View style={[styles.card, { backgroundColor: surface.raised }]} testID="tarot-card">
    <Text style={[styles.cardIndex, { color: surface.textMuted }]}>
      {`${card.index} · MAJOR ARCANA`}
    </Text>
    <Text style={[styles.cardName, { color: surface.text }]} testID="tarot-card-name">
      {card.name}
    </Text>
    <Text style={[styles.cardKeyword, { color: surface.textSoft }]} testID="tarot-card-keyword">
      {card.keyword}
    </Text>
    <Text style={[styles.cardSymbolism, { color: surface.textSoft }]} testID="tarot-card-symbolism">
      {card.symbolism}
    </Text>
  </View>
);

const TarotSaveButton = ({ onSave }: { onSave?: () => void }): React.JSX.Element => (
  <View style={styles.completeRow}>
    <SessionCtaButton
      variant="success"
      label="Save session"
      accessibilityLabel="Save session and reflect"
      disabled={!onSave}
      onPress={onSave}
      testID="tarot-save"
      accessibilityState={{ disabled: !onSave }}
    />
  </View>
);

const styles = StyleSheet.create({
  card: {
    width: 260,
    minHeight: 360,
    borderRadius: BORDER_RADIUS.xl,
    borderWidth: 2,
    borderColor: colors.secondary,
    padding: SPACING.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xl,
    ...shadows.medium,
  },
  cardIndex: {
    fontSize: 11,
    letterSpacing: 3,
    marginBottom: SPACING.md,
  },
  cardName: {
    fontSize: 26,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  cardKeyword: {
    fontSize: 14,
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  cardSymbolism: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: SPACING.sm,
  },
  completeRow: { alignItems: 'center', marginTop: SPACING.md },
});

export default TarotMeditationView;
