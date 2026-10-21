/**
 * A non-chargeable resonance pass needs a remedy, not a disabled spend choice.
 *
 * The empty-wallet branch offers credits (as a letter's empty-wallet offer does), because a
 * reading the writer's own vault answers is the one thing credits pay for
 * (ADR 0009 phase (a), #3067). It offers them only when the credit pack page is
 * configured (#3262): a link to it, and a note to buy with the same email
 * address as the Adepthood account. Without that page it offers only the reset
 * date, and says nothing about buying credits. It never offers a key: a vault
 * answers these readings and never uses one. The remedy itself lives in
 * ``WalletRemedy`` because a letter's offer meets the same empty wallet (#3386).
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import JournalModalShell from './JournalModalShell';
import type { ResonanceRefillReason } from './useResonanceExplainer';
import {
  CreditPackOffer,
  configuredCreditPackUrl,
  resetAvailabilityCopy,
  walletCancelA11y,
} from './WalletRemedy';

import { colors, editorialType, journalLayout, spacing, touchTarget } from '@/design/tokens';

const TITLE = 'Nothing to pay for the reading with';
const ADD_KEY = 'Add your API key';
const NOT_NOW = 'Not now';
const NOT_NOW_KEY_A11Y = 'Not now — do not add an API key';

interface Props {
  visible: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
  reason: ResonanceRefillReason;
  onAddKey: () => void;
  onCancel: () => void;
}

function RefillMessage({
  reason,
  resetCopy,
  packUrl,
}: {
  reason: ResonanceRefillReason;
  resetCopy: string;
  packUrl: string | null;
}): React.JSX.Element {
  if (reason === 'key_required') {
    return (
      <Text style={styles.body}>
        Resonance needs an API key of your own before it can read this entry, so nothing was
        charged. You can add one in Settings.
      </Text>
    );
  }
  return (
    <>
      <Text style={styles.body}>
        Your BotMason balance has run out, so nothing was charged. Readings your vault answers use
        BotMason credits, even when an API key is saved. {resetCopy}
      </Text>
      {packUrl === null ? null : (
        <CreditPackOffer url={packUrl} testID="journal-resonance-refill-credit-pack" />
      )}
    </>
  );
}

function KeyAction({
  keyRequired,
  onAddKey,
}: {
  keyRequired: boolean;
  onAddKey: () => void;
}): React.JSX.Element | null {
  return keyRequired ? (
    <TouchableOpacity
      style={[styles.action, styles.addKey]}
      onPress={onAddKey}
      accessibilityRole="button"
      accessibilityLabel="Add your API key"
      testID="journal-resonance-refill-add-key"
    >
      <Text style={styles.addKeyLabel}>{ADD_KEY}</Text>
    </TouchableOpacity>
  ) : null;
}

export default function ResonanceRefillDialog({
  visible,
  monthlyResetDate,
  monthlyCap,
  reason,
  onAddKey,
  onCancel,
}: Props): React.JSX.Element {
  const resetCopy = resetAvailabilityCopy(monthlyCap, monthlyResetDate);
  const keyRequired = reason === 'key_required';
  // Read at render, not at import: the page is meant to be replaceable.
  const packUrl = configuredCreditPackUrl();
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
      <ScrollView style={styles.scroll}>
        <Text style={styles.title} accessibilityRole="header">
          {keyRequired ? 'API key needed for Resonance' : TITLE}
        </Text>
        <RefillMessage reason={reason} resetCopy={resetCopy} packUrl={packUrl} />
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.action}
            onPress={onCancel}
            accessibilityRole="button"
            // Names what is on this card: a key, or credits, or nothing (#3388).
            accessibilityLabel={keyRequired ? NOT_NOW_KEY_A11Y : walletCancelA11y(packUrl)}
            testID="journal-resonance-refill-cancel"
          >
            <Text style={styles.cancelLabel}>{NOT_NOW}</Text>
          </TouchableOpacity>
          <KeyAction keyRequired={keyRequired} onAddKey={onAddKey} />
        </View>
      </ScrollView>
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  scroll: { flexShrink: 1 },
  card: {
    maxHeight: '90%',
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
