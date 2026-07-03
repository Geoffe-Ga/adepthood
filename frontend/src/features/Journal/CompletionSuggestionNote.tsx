/**
 * ``CompletionSuggestionNote`` — an actionable margin card (sibling to
 * ``MarginNote``) for a detected completion. Pressing *Get Resonance* pins it
 * next to the sentence the writer wrote, e.g. "You wrote about **Daily run**.
 * Check it off?", with a clear **OK** and a quiet **Not now**. OK logs the
 * completion and the card settles into "✓ Checked off — N-day streak".
 *
 * Four states keyed off the suggestion status + a local in-flight flag:
 * pending (question + actions), accepting (disabled, "Checking…"), accepted
 * (confirmation + streak), dismissed (renders nothing). Presentational +
 * reduced-motion-safe; tokens only.
 */
import React, { useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { usePressScale } from './motion';
import { paperMarginCard } from './noteCards';

import type { CheckInResult, CompletionSuggestion } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const QUESTION_PREFIX = 'You wrote about ';
const QUESTION_SUFFIX = '. Check it off?';
const OK_LABEL = 'OK';
const DISMISS_LABEL = 'Not now';
const CHECKING_LABEL = 'Checking…';
const CHECKED_LABEL = '✓ Checked off';
const LOGGED_LABEL = '✓ Logged';

/** "N-day streak" from a check-in, or null when there is no streak to show. */
function streakLabel(checkIn: CheckInResult | null): string | null {
  if (!checkIn || checkIn.streak <= 0) return null;
  return `${checkIn.streak}-day streak`;
}

export interface CompletionSuggestionNoteProps {
  suggestion: CompletionSuggestion;
  /** The check-in returned when this suggestion was accepted (for the streak). */
  checkIn: CheckInResult | null;
  onAccept: (_id: number) => void | Promise<void>;
  onDismiss: (_id: number) => void | Promise<void>;
}

/** The settled confirmation shown once a suggestion is accepted.
 *
 * Habits read "✓ Checked off" + an optional streak; practices read "✓ Logged"
 * with no streak line (a journal-attested session has none).
 */
function AcceptedCard({
  id,
  targetType,
  checkIn,
}: {
  id: number;
  targetType: CompletionSuggestion['target_type'];
  checkIn: CheckInResult | null;
}): React.JSX.Element {
  const streak = streakLabel(checkIn);
  const label = targetType === 'practice' ? LOGGED_LABEL : CHECKED_LABEL;
  return (
    <View style={styles.card} testID={`suggestion-${id}`}>
      <Text style={styles.checked} testID={`suggestion-${id}-checked`}>
        {label}
        {streak ? <Text style={styles.streak}>{`  ${streak}`}</Text> : null}
      </Text>
    </View>
  );
}

/** OK / Not now buttons; OK shows "Checking…" + disables both while in-flight. */
function SuggestionActions({
  suggestion,
  accepting,
  onAccept,
  onDismiss,
  press,
}: {
  suggestion: CompletionSuggestion;
  accepting: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  press: ReturnType<typeof usePressScale>;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      <TouchableOpacity
        style={[styles.button, styles.accept, accepting && styles.disabled]}
        onPress={onAccept}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={accepting}
        accessibilityRole="button"
        accessibilityLabel={`Check off ${suggestion.label}`}
        accessibilityState={{ disabled: accepting }}
        testID={`suggestion-${suggestion.id}-accept`}
      >
        <Text style={styles.acceptText}>{accepting ? CHECKING_LABEL : OK_LABEL}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.button, accepting && styles.disabled]}
        onPress={onDismiss}
        disabled={accepting}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss the suggestion to check off ${suggestion.label}`}
        accessibilityState={{ disabled: accepting }}
        testID={`suggestion-${suggestion.id}-dismiss`}
      >
        <Text style={styles.dismissText}>{DISMISS_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** The pending question with OK / Not now (and the in-flight "Checking…"). */
function PendingCard({
  suggestion,
  onAccept,
  onDismiss,
}: Omit<CompletionSuggestionNoteProps, 'checkIn'>): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  const [accepting, setAccepting] = useState(false);

  const handleAccept = async (): Promise<void> => {
    if (accepting) return; // double-tap guard
    setAccepting(true);
    try {
      await onAccept(suggestion.id);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID={`suggestion-${suggestion.id}`}>
        <Text style={styles.question}>
          {QUESTION_PREFIX}
          <Text style={styles.label}>{suggestion.label}</Text>
          {QUESTION_SUFFIX}
        </Text>
        <SuggestionActions
          suggestion={suggestion}
          accepting={accepting}
          onAccept={handleAccept}
          onDismiss={() => onDismiss(suggestion.id)}
          press={press}
        />
      </View>
    </Animated.View>
  );
}

function CompletionSuggestionNote({
  suggestion,
  checkIn,
  onAccept,
  onDismiss,
}: CompletionSuggestionNoteProps): React.JSX.Element | null {
  if (suggestion.status === 'dismissed') return null;
  if (suggestion.status === 'accepted') {
    return (
      <AcceptedCard id={suggestion.id} targetType={suggestion.target_type} checkIn={checkIn} />
    );
  }
  return <PendingCard suggestion={suggestion} onAccept={onAccept} onDismiss={onDismiss} />;
}

const styles = StyleSheet.create({
  card: paperMarginCard(colors.tier.clear),
  question: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
  },
  label: {
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    paddingTop: spacing(1),
  },
  button: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
  accept: {
    backgroundColor: colors.tier.clear,
  },
  acceptText: {
    ...editorialType.caption,
    color: colors.paper.background,
    fontWeight: '600',
  },
  dismissText: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
  disabled: {
    opacity: 0.5,
  },
  checked: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    fontWeight: '600',
  },
  streak: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
});

export default CompletionSuggestionNote;
