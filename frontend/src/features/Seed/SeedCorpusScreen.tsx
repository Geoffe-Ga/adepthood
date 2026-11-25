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
 *
 * **The run is the app's, not this screen's (#3772).** Documents go through the
 * app-level upload queue, so leaving carries on and coming back shows the same
 * rows; the pickers stay open while a batch is going over, and each new pick or
 * folder is queued behind it under its own header. Closing the tab or the app
 * does stop it, and the screen says so while anything is going over.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  SEED_BACKGROUND_NOTE,
  SEED_CHOOSE_LABEL,
  SEED_CONSENT_LINK_LABEL,
  SEED_CONSENT_PROMPT,
  SEED_EMPTY_INVITATION,
  SEED_STOP_ALL_LABEL,
  SEED_STOP_BATCH_LABEL,
  SEED_VAULT_INVITATION,
  SEED_VAULT_INVITATION_LINK_LABEL,
  seedBatchHeaderLine,
  seedProgressLine,
  seedRetryLabel,
  seedSummaryLine,
  seedUnconfirmedLine,
} from './seedCopy';
import { SEED_CHOOSE_FOLDER_LABEL } from './seedFolderCopy';
import { SeedFolderReview } from './SeedFolderReview';
import { SEED_JSON_EXPORT_NOTE, seedStatusLine } from './seedJsonExport';
import type { SeedItem } from './seedRun';
import { SeedRowLanding, SeedVaultReceiptsLink } from './SeedVaultReceipts';
import { useSeedFolder, type SeedFolderController } from './useSeedFolder';
import { useSeedRun, type SeedBatchView, type SeedRunController } from './useSeedRun';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent, BORDER_RADIUS, ink, rhythm, SPACING, surface, touchTarget } from '@/design/tokens';
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
        {seedStatusLine(item)}
      </Text>
      <SeedRowLanding item={item} />
    </View>
  );
};

/** A picker or action button; pickers stay open while a batch goes over (#3772). */
const ChooseButton = ({
  onPress,
  disabled,
  label = SEED_CHOOSE_LABEL,
  testID = 'seed-choose-button',
}: {
  onPress: () => void;
  disabled: boolean;
  label?: string;
  testID?: string;
}): React.JSX.Element => (
  <TouchableOpacity
    style={[styles.chooseButton, disabled ? styles.chooseButtonDisabled : null]}
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    testID={testID}
  >
    <Text style={styles.chooseButtonText}>{label}</Text>
  </TouchableOpacity>
);

/**
 * The folder half of the picker: a "choose a folder" button where the browser
 * can choose one, its notice, and the review a chosen folder waits in. Nothing
 * at all on a platform with no folder picker, which keeps the file picker.
 */
const SeedFolderSection = ({
  folder,
}: {
  folder: SeedFolderController;
}): React.JSX.Element | null => {
  if (!folder.supported) return null;
  return (
    <>
      <ChooseButton
        onPress={() => void folder.chooseFolder()}
        disabled={folder.review !== null}
        label={SEED_CHOOSE_FOLDER_LABEL}
        testID="seed-choose-folder-button"
      />
      {folder.notice ? (
        <Text style={styles.notice} testID="seed-folder-notice">
          {folder.notice}
        </Text>
      ) : null}
      {folder.review ? <SeedFolderReview folder={folder} review={folder.review} /> : null}
    </>
  );
};

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

/**
 * While anything is going over: that it carries on around the app, that closing
 * the tab or the app stops it, and the way to stop it here.
 */
const SeedQueueControls = ({ run }: { run: SeedRunController }): React.JSX.Element | null => {
  if (!run.isSending) return null;
  return (
    <View testID="seed-background-note">
      <Text style={styles.notice}>{SEED_BACKGROUND_NOTE}</Text>
      <TouchableOpacity
        onPress={run.cancel}
        accessibilityRole="button"
        accessibilityLabel={SEED_STOP_ALL_LABEL}
        testID="seed-stop-all"
      >
        <Text style={styles.stop}>{SEED_STOP_ALL_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
};

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

/**
 * The offer to send again the documents that did not go over (#3556): only
 * once the run is idle, only while there is something a retry may send, and
 * counting exactly that. Anything that landed is never part of it.
 */
const RetryButton = ({ run }: { run: SeedRunController }): React.JSX.Element | null => {
  if (run.isSending || run.retryableCount === 0) return null;
  return (
    <ChooseButton
      onPress={() => void run.retryFailed()}
      disabled={false}
      label={seedRetryLabel(run.retryableCount)}
      testID="seed-retry-button"
    />
  );
};

/** One batch's header row: where it stands, and the way to stop it while it has more to send. */
const SeedBatchHeaderRow = ({
  batch,
  onStop,
}: {
  batch: SeedBatchView;
  onStop: (_batchId: string) => void;
}): React.JSX.Element => (
  <View style={styles.batchHeader}>
    <Text style={styles.batchHeaderText} testID={`seed-batch-header-${batch.id}`}>
      {seedBatchHeaderLine({
        name: batch.name,
        state: batch.state,
        total: batch.items.length,
        remaining: batch.remaining,
      })}
    </Text>
    <Text style={styles.batchCounts} testID={`seed-batch-counts-${batch.id}`}>
      {seedSummaryLine(batch.tally)}
    </Text>
    {batch.remaining > 0 ? (
      <TouchableOpacity
        onPress={() => onStop(batch.id)}
        accessibilityRole="button"
        accessibilityLabel={SEED_STOP_BATCH_LABEL}
        testID={`seed-batch-stop-${batch.id}`}
      >
        <Text style={styles.stop}>{SEED_STOP_BATCH_LABEL}</Text>
      </TouchableOpacity>
    ) : null}
  </View>
);

/** The chosen documents, batch by batch, and how far each one got. */
const SeedRunList = ({ run }: { run: SeedRunController }): React.JSX.Element | null => {
  if (run.batches.length === 0) {
    return null;
  }
  return (
    <EditorialSection title="What you've brought" testID="seed-run-list">
      {run.batches.map((batch) => (
        <View key={batch.id} testID={`seed-batch-${batch.id}`}>
          <SeedBatchHeaderRow batch={batch} onStop={run.cancelBatch} />
          {batch.items.map((item) => (
            <SeedItemRow key={item.id} item={item} />
          ))}
        </View>
      ))}
    </EditorialSection>
  );
};

interface SeedCorpusBodyProps {
  run: SeedRunController;
  folder: SeedFolderController;
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

/**
 * The whole queue's counts (#3771) -- landed, failed, remaining, skipped -- and,
 * beneath them, the failed that may have arrived after all.
 */
const SeedSummary = ({ run }: { run: SeedRunController }): React.JSX.Element | null => {
  const summary = seedSummaryLine(run.tally);
  if (summary === null) return null;
  const unconfirmed = seedUnconfirmedLine(run.tally);
  return (
    <>
      <Text style={styles.summary} testID="seed-summary">
        {summary}
      </Text>
      {unconfirmed ? (
        <Text style={styles.summaryDetail} testID="seed-summary-unconfirmed">
          {unconfirmed}
        </Text>
      ) : null}
    </>
  );
};

/** The screen body, given a run to read and drive. */
const SeedCorpusBody = ({ run, folder, onOpenConsent }: SeedCorpusBodyProps): React.JSX.Element => {
  return (
    <>
      <SeedHeader />
      <EditorialSection title="Privacy" testID="seed-privacy">
        <Text style={styles.tierPrompt}>{TIER_PROMPT}</Text>
        <PrivacyTierControl value={run.classification} onChange={run.chooseClassification} />
      </EditorialSection>
      <Text style={styles.notice} testID="seed-json-export-note">
        {SEED_JSON_EXPORT_NOTE}
      </Text>
      <ChooseButton onPress={() => void run.choose()} disabled={false} />
      <SeedFolderSection folder={folder} />
      <SeedProgress line={seedProgressLine(run.tally, run.isPaused, run.isWaitingOnVault)} />
      <SeedQueueControls run={run} />
      {run.notice ? (
        <Text style={styles.notice} testID="seed-notice">
          {run.notice}
        </Text>
      ) : null}
      <SeedSummary run={run} />
      {run.needsConsent ? (
        <SeedInvitation
          prompt={SEED_CONSENT_PROMPT}
          linkLabel={SEED_CONSENT_LINK_LABEL}
          onPress={onOpenConsent}
          testID="seed-consent-invitation"
          linkTestID="seed-consent-link"
        />
      ) : null}
      <RetryButton run={run} />
      <SeedVaultReceiptsLink items={run.items} isSending={run.isSending} />
      <SeedRunList run={run} />
    </>
  );
};

/** The corpus-seeding screen. */
function SeedCorpusScreen(): React.JSX.Element {
  const run = useSeedRun();
  const folder = useSeedFolder(run.sendDocuments);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const openConsent = useCallback(() => navigation.navigate('CorpusConsent'), [navigation]);
  const openVault = useCallback(() => navigation.navigate('VaultSettings'), [navigation]);
  const { state: vault } = useVaultConnectionState();
  return (
    <ScreenScaffold scroll testID="seed-corpus-screen">
      {vaultComesFirst(vault) ? (
        <SeedVaultFirst onOpenVault={openVault} />
      ) : (
        <SeedCorpusBody run={run} folder={folder} onOpenConsent={openConsent} />
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
  stop: {
    color: accent.primary,
    fontWeight: '600',
    minHeight: touchTarget.minimum,
    paddingTop: SPACING.md,
  },
  batchHeader: {
    marginTop: SPACING.md,
  },
  batchHeaderText: {
    color: ink.primary,
    fontWeight: '600',
  },
  batchCounts: {
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  notice: {
    color: ink.soft,
    marginTop: SPACING.md,
  },
  summary: {
    color: ink.primary,
    marginTop: SPACING.md,
  },
  summaryDetail: {
    color: ink.soft,
    marginTop: SPACING.xs,
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
