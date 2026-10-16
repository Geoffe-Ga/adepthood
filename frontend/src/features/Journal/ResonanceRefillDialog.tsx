/**
 * A non-chargeable resonance pass needs a remedy, not a disabled spend choice.
 *
 * The empty-wallet branch is the one place the app offers credits, because a
 * reading the writer's own vault answers is the one thing credits pay for
 * (ADR 0009 phase (a), #3067). It offers them only when the credit pack page is
 * configured (#3262): a link to it, and a note to buy with the same email
 * address as the Adepthood account. Without that page it offers only a key, and
 * says nothing about buying credits.
 */
import React, { useCallback } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  CREDIT_PACK_LINK,
  CREDIT_PACK_LINK_A11Y,
  CREDIT_PACK_SAME_EMAIL,
  creditPackUrl,
} from './creditPack';
import JournalModalShell from './JournalModalShell';
import type { ResonanceRefillReason } from './useResonanceExplainer';

import { CREDIT_PACK_URL } from '@/config';
import { colors, editorialType, journalLayout, spacing, touchTarget } from '@/design/tokens';
import { openExternalUrl } from '@/utils/openExternalUrl';

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

/** The pack page and the one thing a buyer must get right. */
function CreditPackOffer({ url }: { url: string }): React.JSX.Element {
  const open = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);
  return (
    <View testID="journal-resonance-refill-credit-pack">
      <TouchableOpacity
        style={styles.packLink}
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel={CREDIT_PACK_LINK_A11Y}
        testID="journal-resonance-refill-credit-pack-link"
      >
        <Text style={styles.packLinkLabel}>{CREDIT_PACK_LINK}</Text>
      </TouchableOpacity>
      <Text style={styles.packNote}>{CREDIT_PACK_SAME_EMAIL}</Text>
    </View>
  );
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
      {packUrl === null ? null : <CreditPackOffer url={packUrl} />}
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
  const reset = formatResonanceResetDate(monthlyResetDate);
  const resetCopy = resetAvailabilityCopy(monthlyCap, reset);
  const keyRequired = reason === 'key_required';
  // Read at render, not at import: the page is meant to be replaceable.
  const packUrl = creditPackUrl(CREDIT_PACK_URL);
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
            accessibilityLabel="Not now — do not add an API key"
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
  packLink: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    marginTop: spacing(1),
  },
  packLinkLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
    textDecorationLine: 'underline',
  },
  packNote: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
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
