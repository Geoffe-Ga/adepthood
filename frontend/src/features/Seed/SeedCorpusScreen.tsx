/**
 * "Bring in what you've written" — the screen where a person hands documents
 * they already have to their corpus, so reflections read from everything they
 * have written rather than only what they have typed here.
 *
 * **A corpus lives in a vault (#3015).** A document goes to the account's vault
 * or nowhere, so this screen reads the account's vault once on mount (#3017).
 * When the server says nothing is attached, the picker is replaced by an
 * invitation to give the corpus a place first — never a dead end, and the
 * screen itself stays where it is. Every other answer, including a read still
 * out or one that failed, keeps the picker: unknown is never read as none, and
 * the server's own `vault_required` answer is the backstop. Where a sent
 * document lands is still the server's answer, and each row reports it.
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
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  SEED_CHOOSE_LABEL,
  SEED_CONSENT_LINK_LABEL,
  SEED_CONSENT_PROMPT,
  SEED_EMPTY_INVITATION,
  SEED_LEAVE_CONFIRM_LABEL,
  SEED_LEAVE_STAY_LABEL,
  SEED_LEAVE_TITLE,
  SEED_LEAVE_WARNING,
  SEED_STATUS_LINES,
  SEED_VAULT_INVITATION,
  SEED_VAULT_INVITATION_LINK_LABEL,
  seedProgressLine,
  seedSummaryLine,
} from './seedCopy';
import type { SeedItem } from './seedRun';
import { useSeedLeaveGuard } from './useSeedLeaveGuard';
import { useSeedRun, type SeedRunController } from './useSeedRun';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import {
  accent,
  BORDER_RADIUS,
  colors,
  ink,
  rhythm,
  SPACING,
  surface,
  touchTarget,
} from '@/design/tokens';
import PrivacyTierControl from '@/features/Journal/PrivacyTierControl';
import { useVaultConnectionState } from '@/features/Settings/useVaultConnectionState';
import { vaultComesFirst } from '@/features/Settings/vaultConnectionState';
import type { RootStackParamList } from '@/navigation/RootStack';

/** Sits above the tier control, so the choice reads as a choice. */
const TIER_PROMPT = 'Everything you choose now is kept at the privacy level you pick here.';

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
 * How far along the run is, while it is going over.
 *
 * A moving indicator alongside the position, because the per-row text and a
 * disabled button are both static: a run whose documents each take a round
 * trip can sit for a long time looking hung. The position counts the whole
 * run, which is exactly the list rendered below it.
 */
const SeedProgress = ({ line }: { line: string | null }): React.JSX.Element | null => {
  if (line === null) {
    return null;
  }
  return (
    <View
      style={styles.progress}
      testID="seed-progress"
      accessibilityRole="progressbar"
      accessibilityLabel={line}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator color={accent.primary} />
      <Text style={styles.progressText} testID="seed-progress-line">
        {line}
      </Text>
    </View>
  );
};

interface SeedLeavePromptProps {
  onLeave: () => void;
  onStay: () => void;
}

/**
 * The question asked before an active run is left, with both answers spelled
 * out. Staying is offered first: it is the one that changes nothing.
 *
 * A modal rather than a banner in the scroll, because the exit it is answering
 * has already been held: somebody scrolled down a long run would otherwise
 * find their tap on Back had simply done nothing, with the reason off screen.
 * The hardware back gesture answers "stay" — the safe half of the choice.
 */
const SeedLeavePrompt = ({ onLeave, onStay }: SeedLeavePromptProps): React.JSX.Element => (
  <Modal visible transparent animationType="fade" onRequestClose={onStay}>
    <View style={styles.leaveScrim} accessibilityViewIsModal>
      <View style={styles.leavePrompt} testID="seed-leave-prompt" accessibilityRole="alert">
        <Text style={styles.leaveTitle}>{SEED_LEAVE_TITLE}</Text>
        <Text style={styles.leaveWarning}>{SEED_LEAVE_WARNING}</Text>
        <TouchableOpacity
          onPress={onStay}
          accessibilityRole="button"
          accessibilityLabel={SEED_LEAVE_STAY_LABEL}
          testID="seed-leave-stay"
        >
          <Text style={styles.leaveStay}>{SEED_LEAVE_STAY_LABEL}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onLeave}
          accessibilityRole="button"
          accessibilityLabel={SEED_LEAVE_CONFIRM_LABEL}
          testID="seed-leave-confirm"
        >
          <Text style={styles.leaveConfirm}>{SEED_LEAVE_CONFIRM_LABEL}</Text>
        </TouchableOpacity>
      </View>
    </View>
  </Modal>
);

interface SeedInvitationProps {
  prompt: string;
  linkLabel: string;
  onPress: () => void;
  testID: string;
  linkTestID: string;
}

/**
 * A sentence and the way somewhere else, asking for nothing here.
 *
 * Two uses. The consent one is shown only once the server has actually answered
 * `consent_required`, so it is a response to something that happened rather
 * than a pre-flight check this screen invented; agreeing to have documents
 * sorted is a decision made where its consequences are spelled out. The vault
 * one is shown in place of the picker when there is nowhere to keep a document
 * yet (#3017), and leads to where a corpus lives.
 */
const SeedInvitation = ({
  prompt,
  linkLabel,
  onPress,
  testID,
  linkTestID,
}: SeedInvitationProps): React.JSX.Element => (
  <View style={styles.consent} testID={testID}>
    <Text style={styles.consentPrompt}>{prompt}</Text>
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={linkLabel}
      testID={linkTestID}
    >
      <Text style={styles.consentLink}>{linkLabel}</Text>
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

/** The screen's heading, the same whether or not there is a picker beneath it. */
const SeedHeader = (): React.JSX.Element => (
  <ScreenHeader
    eyebrow="Your writing"
    title="Bring in what you've written"
    lead={SEED_EMPTY_INVITATION}
  />
);

/** What the screen shows when there is nowhere to keep a document yet (#3017). */
const SeedVaultFirst = ({ onOpenVault }: { onOpenVault: () => void }): React.JSX.Element => (
  <>
    <SeedHeader />
    <SeedInvitation
      prompt={SEED_VAULT_INVITATION}
      linkLabel={SEED_VAULT_INVITATION_LINK_LABEL}
      onPress={onOpenVault}
      testID="seed-vault-invitation"
      linkTestID="seed-vault-invitation-link"
    />
  </>
);

/** The screen body, given a run to read and drive. */
const SeedCorpusBody = ({ run, onOpenConsent }: SeedCorpusBodyProps): React.JSX.Element => {
  const summary = seedSummaryLine(run.tally);
  return (
    <>
      <SeedHeader />
      <EditorialSection title="Privacy" testID="seed-privacy">
        <Text style={styles.tierPrompt}>{TIER_PROMPT}</Text>
        <PrivacyTierControl value={run.classification} onChange={run.chooseClassification} />
      </EditorialSection>
      <ChooseButton onPress={run.choose} disabled={run.isSending} />
      <SeedProgress line={seedProgressLine(run.tally)} />
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
      {run.needsConsent ? (
        <SeedInvitation
          prompt={SEED_CONSENT_PROMPT}
          linkLabel={SEED_CONSENT_LINK_LABEL}
          onPress={onOpenConsent}
          testID="seed-consent-invitation"
          linkTestID="seed-consent-link"
        />
      ) : null}
      <SeedRunList items={run.items} />
    </>
  );
};

/** The corpus-seeding screen. */
function SeedCorpusScreen(): React.JSX.Element {
  const run = useSeedRun();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const openConsent = useCallback(() => navigation.navigate('CorpusConsent'), [navigation]);
  const openVault = useCallback(() => navigation.navigate('VaultSettings'), [navigation]);
  const leaveGuard = useSeedLeaveGuard(run.isSending, run.cancel);
  const { state: vault } = useVaultConnectionState();
  return (
    <ScreenScaffold scroll testID="seed-corpus-screen">
      {leaveGuard.isPrompting ? (
        <SeedLeavePrompt onLeave={leaveGuard.confirmLeave} onStay={leaveGuard.stay} />
      ) : null}
      {vaultComesFirst(vault) ? (
        <SeedVaultFirst onOpenVault={openVault} />
      ) : (
        <SeedCorpusBody run={run} onOpenConsent={openConsent} />
      )}
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
  progress: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  progressText: {
    color: ink.soft,
  },
  leaveScrim: {
    backgroundColor: colors.mystical.overlay,
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  leavePrompt: {
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: SPACING.md,
  },
  leaveTitle: {
    color: ink.primary,
    fontWeight: '600',
  },
  leaveWarning: {
    color: ink.soft,
    lineHeight: 20,
    marginTop: SPACING.sm,
  },
  leaveStay: {
    color: accent.primary,
    fontWeight: '600',
    minHeight: touchTarget.minimum,
    paddingTop: SPACING.md,
  },
  leaveConfirm: {
    color: ink.soft,
    fontWeight: '600',
    minHeight: touchTarget.minimum,
    paddingTop: SPACING.md,
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
