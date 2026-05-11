import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TarotCard } from '../data/tarot';
import type { RitualControls, RitualState } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';

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
  const showTimer =
    state.status === 'paused' ||
    state.status === 'complete' ||
    (state.status === 'running' && !hideTimer);
  return (
    <View style={styles.container} testID="tarot-meditation-view">
      <TarotCardFace card={card} />
      {showTimer && (
        <Text style={styles.timer} testID="tarot-time-remaining">
          {formatTime(state.remainingMs ?? 0)}
        </Text>
      )}
      <TarotFooter state={state} controls={controls} hideTimer={hideTimer} onSave={onSave} />
    </View>
  );
};

const TarotCardFace = ({ card }: { card: TarotCard }): React.JSX.Element => (
  <View style={styles.card} testID="tarot-card">
    <Text style={styles.cardIndex}>{`${card.index} · MAJOR ARCANA`}</Text>
    <Text style={styles.cardName} testID="tarot-card-name">
      {card.name}
    </Text>
    <Text style={styles.cardKeyword} testID="tarot-card-keyword">
      {card.keyword}
    </Text>
    <Text style={styles.cardSymbolism} testID="tarot-card-symbolism">
      {card.symbolism}
    </Text>
  </View>
);

interface FooterProps {
  state: RitualState;
  controls: RitualControls;
  hideTimer: boolean;
  onSave?: () => void;
}

const TarotFooter = ({ state, controls, hideTimer, onSave }: FooterProps): React.JSX.Element => {
  if (state.status === 'idle') {
    return (
      <Pressable
        style={styles.begin}
        onPress={controls.start}
        testID="tarot-begin"
        accessibilityRole="button"
        accessibilityLabel="Begin meditation"
      >
        <Text style={styles.beginText}>Begin meditation</Text>
      </Pressable>
    );
  }
  if (state.status === 'running' && hideTimer) {
    return (
      <Pressable
        style={styles.longCancel}
        onLongPress={controls.cancel}
        delayLongPress={800}
        testID="tarot-cancel-longpress"
        accessibilityRole="button"
        accessibilityLabel="Long-press to cancel meditation"
        accessibilityHint="Hold to end the sit early without revealing the timer."
      >
        <Text style={styles.longCancelText}>Hold to cancel</Text>
      </Pressable>
    );
  }
  if (state.status === 'paused') {
    return <RitualControlsBar status={state.status} controls={controls} startLabel="Begin" />;
  }
  if (state.status === 'complete') {
    return (
      <View style={styles.completeRow}>
        <Pressable
          style={styles.save}
          onPress={onSave}
          disabled={!onSave}
          testID="tarot-save"
          accessibilityRole="button"
          accessibilityLabel="Save session and reflect"
        >
          <Text style={styles.saveText}>Save session</Text>
        </Pressable>
      </View>
    );
  }
  // status === 'running' && !hideTimer — let the parent surface the standard
  // controls bar; the timer is already visible above.
  return <RitualControlsBar status={state.status} controls={controls} startLabel="Begin" />;
};

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: SPACING.xl },
  card: {
    width: 260,
    minHeight: 360,
    backgroundColor: colors.background.card,
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
    color: colors.text.tertiaryAccessible,
    marginBottom: SPACING.md,
  },
  cardName: {
    fontSize: 26,
    fontWeight: '600',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  cardKeyword: {
    fontSize: 14,
    fontStyle: 'italic',
    color: colors.text.secondaryAccessible,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  cardSymbolism: {
    fontSize: 13,
    color: colors.text.secondaryAccessible,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: SPACING.sm,
  },
  timer: {
    fontSize: 36,
    fontWeight: '300',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACING.lg,
  },
  begin: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.buttonV,
    paddingHorizontal: SPACING.xxl,
    borderRadius: BORDER_RADIUS.lg,
    minWidth: 220,
    alignItems: 'center',
    ...shadows.small,
  },
  beginText: { color: colors.text.light, fontSize: 18, fontWeight: '600' },
  longCancel: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: colors.text.tertiaryAccessible,
  },
  longCancelText: {
    color: colors.text.tertiaryAccessible,
    fontSize: 13,
    letterSpacing: 1,
  },
  completeRow: { alignItems: 'center', marginTop: SPACING.md },
  save: {
    backgroundColor: colors.success,
    paddingVertical: SPACING.buttonV,
    paddingHorizontal: SPACING.xxl,
    borderRadius: BORDER_RADIUS.lg,
    minWidth: 220,
    alignItems: 'center',
    ...shadows.small,
  },
  saveText: { color: colors.text.light, fontSize: 18, fontWeight: '600' },
});

export default TarotMeditationView;
