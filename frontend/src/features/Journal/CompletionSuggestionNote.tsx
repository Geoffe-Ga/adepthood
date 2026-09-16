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
import { FACT_SEPARATOR } from './suggestionFacts';

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
/**
 * How the question ends once the card can say what OK will log. The writer is
 * consenting to a specific amount on a specific day, so "Log it?" is the
 * honest verb; the fact-free branch keeps "Check it off?" verbatim.
 */
const FACTS_SUFFIX = '. Log it?';
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
  /**
   * What the accept will log, already formatted — e.g. `"64 oz · yesterday"`.
   * Pre-formatted rather than derived here on purpose: building it needs the
   * goal's unit from the habit store and the user's own today, and this card
   * stays presentational (no `useAuth`, no store subscription, no clock), which
   * is what lets its tests render it bare with no provider. `null` when the
   * server extracted nothing, which restores the original copy exactly.
   */
  facts?: string | null;
  onAccept: (_id: number) => void | Promise<void>;
  onDismiss: (_id: number) => void | Promise<void>;
}

/**
 * The facts as a screen reader should hear them.
 *
 * The middle dot is a visual separator; announced, it is either silence or the
 * word "dot" depending on the reader, so the spoken label uses commas.
 */
const spokenFacts = (facts: string | null | undefined): string =>
  facts ? `, ${facts.split(FACT_SEPARATOR).join(', ')}` : '';

/** The settled confirmation shown once a suggestion is accepted.
 *
 * Habits read "✓ Checked off" + an optional streak; practices read "✓ Logged"
 * with no streak line (a journal-attested session has none).
 */
function AcceptedCard({
  id,
  targetType,
  checkIn,
  facts,
}: {
  id: number;
  targetType: CompletionSuggestion['target_type'];
  checkIn: CheckInResult | null;
  facts?: string | null;
}): React.JSX.Element {
  const streak = targetType === 'practice' ? null : streakLabel(checkIn);
  const label = targetType === 'practice' ? LOGGED_LABEL : CHECKED_LABEL;
  // A practice carries no facts by construction (the backend CHECK
  // `ck_completion_suggestion_facts_habit_only` keeps both fields null), so the
  // settled practice copy needs no branch of its own here.
  return (
    <View style={styles.card} testID={`suggestion-${id}`}>
      <Text style={styles.checked} testID={`suggestion-${id}-checked`}>
        {label}
        {facts === null || facts === undefined ? '' : `${FACT_SEPARATOR}${facts}`}
        {streak ? <Text style={styles.streak}>{`  ${streak}`}</Text> : null}
      </Text>
    </View>
  );
}

/** OK / Not now buttons; OK shows "Checking…" + disables both while in-flight. */
function SuggestionActions({
  suggestion,
  facts,
  accepting,
  onAccept,
  onDismiss,
  press,
}: {
  suggestion: CompletionSuggestion;
  facts?: string | null;
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
        accessibilityLabel={`Check off ${suggestion.label}${spokenFacts(facts)}`}
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
  facts,
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
          {facts === null || facts === undefined
            ? QUESTION_SUFFIX
            : `${FACT_SEPARATOR}${facts}${FACTS_SUFFIX}`}
        </Text>
        <SuggestionActions
          suggestion={suggestion}
          facts={facts}
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
  facts = null,
  onAccept,
  onDismiss,
}: CompletionSuggestionNoteProps): React.JSX.Element | null {
  if (suggestion.status === 'dismissed') return null;
  if (suggestion.status === 'accepted') {
    return (
      <AcceptedCard
        id={suggestion.id}
        targetType={suggestion.target_type}
        checkIn={checkIn}
        facts={facts}
      />
    );
  }
  return (
    <PendingCard suggestion={suggestion} facts={facts} onAccept={onAccept} onDismiss={onDismiss} />
  );
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
    ...editorialType.action,
    color: colors.paper.background,
  },
  dismissText: {
    ...editorialType.action,
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
