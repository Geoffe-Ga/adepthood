/** A non-chargeable resonance pass needs a remedy, not a disabled spend choice. */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import JournalModalShell from './JournalModalShell';
import type { ResonanceRefillReason } from './useResonanceExplainer';

import { colors, editorialType, journalLayout, spacing, touchTarget } from '@/design/tokens';

const TITLE = 'Nothing to pay for the reading with';
const ADD_KEY = 'Add your API key';
const NOT_NOW = 'Not now';
/** Preserve the server's calendar date instead of shifting it through the device zone. */
export function formatResonanceResetDate(value: string | null): string | null {
  if (value === null) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateOnly === null) return null;
  const [, year, month, day] = dateOnly;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

interface Props {
  visible: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
  reason: ResonanceRefillReason;
  onAddKey: () => void;
  onCancel: () => void;
}

function resetAvailabilityCopy(monthlyCap: number | null, reset: string | null): string {
  if (reset === null) return 'Check your BotMason balance again later.';
  return monthlyCap !== null && monthlyCap > 0
    ? `Your BotMason messages reset on ${reset}.`
    : `Your next monthly reset is ${reset}.`;
}

function RefillMessage({
  reason,
  resetCopy,
}: {
  reason: ResonanceRefillReason;
  resetCopy: string;
}): React.JSX.Element {
  if (reason === 'key_required') {
    return (
      <Text style={styles.body}>
        This deployment needs an API key before Resonance can read this entry.
      </Text>
    );
  }
  return (
    <Text style={styles.body}>
      Your BotMason balance has run out. Add your own API key and Resonance bills that key.{' '}
      {resetCopy}
    </Text>
  );
}

export default function ResonanceRefillDialog({
  visible,
  monthlyResetDate,
  monthlyCap,
  reason,
  onAddKey,
  onCancel,
}: Props): React.JSX.Element {
  const reset = formatResonanceResetDate(monthlyResetDate);
  const resetCopy = resetAvailabilityCopy(monthlyCap, reset);
  const keyRequired = reason === 'key_required';
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onCancel}
      scrimTestID="journal-resonance-refill-scrim"
      scrimLabel="Dismiss the resonance payment invitation"
      modalTestID="journal-resonance-refill"
      cardTestID="journal-resonance-refill-card"
      cardStyle={styles.card}
    >
      <Text style={styles.title} accessibilityRole="header">
        {keyRequired ? 'API key needed for Resonance' : TITLE}
      </Text>
      <RefillMessage reason={reason} resetCopy={resetCopy} />
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.action}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Not now — do not add an API key"
          testID="journal-resonance-refill-cancel"
        >
          <Text style={styles.cancelLabel}>{NOT_NOW}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.action, styles.addKey]}
          onPress={onAddKey}
          accessibilityRole="button"
          accessibilityLabel="Add your API key"
          testID="journal-resonance-refill-add-key"
        >
          <Text style={styles.addKeyLabel}>{ADD_KEY}</Text>
        </TouchableOpacity>
      </View>
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth,
    alignSelf: 'center',
  },
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  actions: {
    flexDirection: 'row',
    gap: spacing(1),
    marginTop: spacing(1.5),
  },
  action: {
    flex: 1,
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addKey: {
    backgroundColor: colors.primary,
  },
  addKeyLabel: {
    ...editorialType.action,
    color: colors.text.light,
  },
  cancelLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
  },
});
