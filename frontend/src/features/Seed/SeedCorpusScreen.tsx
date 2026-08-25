/**
 * "Bring in what you've written" — the screen where a person hands documents
 * they already have to their corpus, so reflections read from everything they
 * have written rather than only what they have typed here.
 *
 * **Where a document lands is the server's answer, not this screen's.** One
 * request goes to `POST /corpus/import`, which routes per account: the vault
 * for somebody who has connected one, their own ontologized corpus for somebody
 * who has not. That is why an account with no vault can seed at all, and why
 * this screen asks no question about vaults — it reports the destination it was
 * told.
 *
 * The invitation is declinable and unhurried: no counter to fill, no streak, no
 * praise for bringing in more. The tier chooser sits above the picker so the
 * choice is made *before* anything is sent, and every document that comes back
 * says plainly where it got to — including the vault that cannot take files
 * yet and the corpus that is waiting on a permission, neither of which is a
 * failure of theirs.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import {
  SEED_CHOOSE_LABEL,
  SEED_CONSENT_LINK_LABEL,
  SEED_CONSENT_PROMPT,
  SEED_EMPTY_INVITATION,
  SEED_STATUS_LINES,
  seedSummaryLine,
} from './seedCopy';
import type { SeedItem } from './seedRun';
import { useSeedRun, type SeedRunController } from './useSeedRun';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent, BORDER_RADIUS, ink, rhythm, SPACING, surface, touchTarget } from '@/design/tokens';
import PrivacyTierControl from '@/features/Journal/PrivacyTierControl';
import type { RootStackParamList } from '@/navigation/RootStack';

/** Sits above the tier control, so the choice reads as a choice. */
const TIER_PROMPT = 'Everything in this batch is stored at the tier you pick here.';

/** One document's row: its own name, and the one true thing about it. */
const SeedItemRow = ({ item }: { item: SeedItem }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  return (
    <View style={styles.row} testID={`seed-item-${item.id}`}>
      <Text style={[styles.rowName, { maxWidth: width }]} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={styles.rowStatus} testID={`seed-item-status-${item.id}`}>
        {SEED_STATUS_LINES[item.status]}
      </Text>
    </View>
  );
};

/** The picker button, inert while a batch is still going over. */
const ChooseButton = ({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled: boolean;
}): React.JSX.Element => (
  <TouchableOpacity
    style={[styles.chooseButton, disabled ? styles.chooseButtonDisabled : null]}
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={SEED_CHOOSE_LABEL}
    accessibilityState={{ disabled }}
    testID="seed-choose-button"
  >
    <Text style={styles.chooseButtonText}>{SEED_CHOOSE_LABEL}</Text>
  </TouchableOpacity>
);

/**
 * The way to the permission a held-back document is waiting on.
 *
 * Shown only once the server has actually answered `consent_required`, so it is
 * a response to something that happened rather than a pre-flight check this
 * screen invented. It leads to the consent screen and asks for nothing here:
 * agreeing to have documents sorted is a decision made where its consequences
 * are spelled out, not a switch smuggled onto an import surface.
 */
const ConsentInvitation = ({ onPress }: { onPress: () => void }): React.JSX.Element => (
  <View style={styles.consent} testID="seed-consent-invitation">
    <Text style={styles.consentPrompt}>{SEED_CONSENT_PROMPT}</Text>
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={SEED_CONSENT_LINK_LABEL}
      testID="seed-consent-link"
    >
      <Text style={styles.consentLink}>{SEED_CONSENT_LINK_LABEL}</Text>
    </TouchableOpacity>
  </View>
);

/** The chosen documents and how far each one got. */
const SeedRunList = ({ items }: { items: readonly SeedItem[] }): React.JSX.Element | null => {
  if (items.length === 0) {
    return null;
  }
  return (
    <EditorialSection title="What you've brought" testID="seed-run-list">
      {items.map((item) => (
        <SeedItemRow key={item.id} item={item} />
      ))}
    </EditorialSection>
  );
};

interface SeedCorpusBodyProps {
  run: SeedRunController;
  onOpenConsent: () => void;
}

/** The screen body, given a run to read and drive. */
const SeedCorpusBody = ({ run, onOpenConsent }: SeedCorpusBodyProps): React.JSX.Element => {
  const summary = seedSummaryLine(run.tally);
  return (
    <>
      <ScreenHeader
        eyebrow="Your corpus"
        title="Bring in what you've written"
        lead={SEED_EMPTY_INVITATION}
      />
      <EditorialSection title="Privacy" testID="seed-privacy">
        <Text style={styles.tierPrompt}>{TIER_PROMPT}</Text>
        <PrivacyTierControl value={run.classification} onChange={run.chooseClassification} />
      </EditorialSection>
      <ChooseButton onPress={run.choose} disabled={run.isSending} />
      {run.notice ? (
        <Text style={styles.notice} testID="seed-notice">
          {run.notice}
        </Text>
      ) : null}
      {summary ? (
        <Text style={styles.summary} testID="seed-summary">
          {summary}
        </Text>
      ) : null}
      {run.needsConsent ? <ConsentInvitation onPress={onOpenConsent} /> : null}
      <SeedRunList items={run.items} />
    </>
  );
};

/** The corpus-seeding screen. */
function SeedCorpusScreen(): React.JSX.Element {
  const run = useSeedRun();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const openConsent = useCallback(() => navigation.navigate('CorpusConsent'), [navigation]);
  return (
    <ScreenScaffold scroll testID="seed-corpus-screen">
      <SeedCorpusBody run={run} onOpenConsent={openConsent} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  tierPrompt: {
    color: ink.soft,
    marginBottom: SPACING.sm,
  },
  chooseButton: {
    alignItems: 'center',
    backgroundColor: accent.primary,
    borderRadius: BORDER_RADIUS.md,
    justifyContent: 'center',
    marginTop: rhythm.sectionGap,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.lg,
  },
  chooseButtonDisabled: {
    backgroundColor: accent.strong,
  },
  chooseButtonText: {
    color: accent.onPrimary,
    fontWeight: '600',
  },
  notice: {
    color: ink.soft,
    marginTop: SPACING.md,
  },
  summary: {
    color: ink.primary,
    marginTop: SPACING.md,
  },
  consent: {
    backgroundColor: surface.sunken,
    borderRadius: BORDER_RADIUS.md,
    marginTop: rhythm.blockGap,
    padding: SPACING.md,
  },
  consentPrompt: {
    color: ink.primary,
    lineHeight: 20,
  },
  consentLink: {
    color: accent.primary,
    fontWeight: '600',
    marginTop: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingTop: SPACING.md,
  },
  row: {
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: SPACING.sm,
    padding: SPACING.md,
  },
  rowName: {
    color: ink.primary,
    fontWeight: '600',
  },
  rowStatus: {
    color: ink.soft,
    marginTop: SPACING.xs,
  },
});

export default SeedCorpusScreen;
