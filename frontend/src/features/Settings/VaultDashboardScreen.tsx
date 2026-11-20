/**
 * "Your vault" (#3776): did my files land, what has Creek done with them, and
 * which parts of my vault hold something -- and which are still quiet, and why.
 *
 * Opened deliberately, from Settings → Where your writing lives or from a
 * finished Seed run, and never pushed anywhere else (NORTH-STAR "Default to
 * quiet"). It renders ``GET /vault/pipeline`` (#3775) in three sections: the
 * receipts of what came in, the passes adepthood ran and the stages Creek
 * stamped on each recent file, and one row per ontology folder with its count.
 * Counts are counts and a finished stage is a tick: no score, no streak, no
 * percent-complete bar.
 *
 * Read once each time the screen comes into focus, and re-read every
 * :data:`VAULT_DASHBOARD_POLL_INTERVAL_MS` only while a pass or a vault job is
 * still going and the screen is in front. Owner-only and read-only: nothing
 * here starts or changes anything.
 */
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { CORPUS_GROUP_TITLE } from './corpusConsentCopy';
import { ManagedVaultReachability } from './ManagedVaultReachability';
import { refreshVaultPipeline, useVaultPipeline } from './useVaultPipeline';
import { VAULT_UNREACHABLE } from './vaultCopy';
import {
  batchCountsLine,
  batchHeading,
  documentStageLabel,
  documentStageMark,
  folderLabel,
  folderNote,
  landedInLine,
  lastPassLine,
  passLine,
  receiptLine,
  VAULT_CREEK_HEADING,
  VAULT_DASHBOARD_LEAD,
  VAULT_DASHBOARD_NO_PASSES,
  VAULT_DASHBOARD_NOT_CONNECTED,
  VAULT_DASHBOARD_NOTHING_YET,
  VAULT_DASHBOARD_OPEN_SETTINGS,
  VAULT_DASHBOARD_READ_FAILURE,
  VAULT_DASHBOARD_RETRY,
  VAULT_DASHBOARD_TITLE,
  VAULT_DOCUMENTS_HEADING,
  VAULT_SHAPE_HEADING,
  VAULT_UPDATE_NEEDED,
  VAULT_UPLOADS_HEADING,
  withheldLine,
} from './vaultDashboardCopy';
import {
  groupReceipts,
  isPipelineBusy,
  passSummary,
  type ReceiptGroup,
} from './vaultDashboardModel';

import type { VaultDocument, VaultFolder, VaultPipeline } from '@/api';
import { Button } from '@/components/Button';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import {
  accent,
  BORDER_RADIUS,
  ink,
  rhythm,
  SPACING,
  surface,
  type as typeRamp,
} from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';
import { detectDeviceTimezone, formatTimeInTZ } from '@/utils/dateUtils';

/**
 * How often a going pass is re-read: often enough to see it move, rare enough
 * to sit quietly beside the rest of the app. Six reads a minute is a tenth of
 * the server's ambient per-client floor (``FALLBACK_RATE_LIMIT``, 60 a minute).
 */
export const VAULT_DASHBOARD_POLL_INTERVAL_MS = 10_000;

interface DashboardNavigation {
  navigate?: (_screen: keyof RootStackParamList) => void;
}

/** A ref that reads ``true`` while the component is mounted. */
function useMounted(): React.MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** Read on every focus; ``reading`` is true until the first read of this visit settles. */
function useFocusRead(): { reading: boolean; read: () => void } {
  const [reading, setReading] = useState(true);
  const mounted = useMounted();
  const read = useCallback(() => {
    setReading(true);
    void refreshVaultPipeline().then(() => {
      if (mounted.current) setReading(false);
    });
  }, [mounted]);
  useFocusEffect(read);
  return { reading, read };
}

/**
 * Re-read every :data:`VAULT_DASHBOARD_POLL_INTERVAL_MS` until cancelled: a
 * chain of timeouts, so a slow read is never overtaken by the next. Returns
 * the cancel.
 */
function pollUntilCancelled(): () => void {
  const state: { cancelled: boolean; timer?: ReturnType<typeof setTimeout> } = {
    cancelled: false,
  };
  function schedule(): void {
    state.timer = setTimeout(() => {
      void refreshVaultPipeline().then(() => {
        if (!state.cancelled) schedule();
      });
    }, VAULT_DASHBOARD_POLL_INTERVAL_MS);
  }
  schedule();
  return () => {
    state.cancelled = true;
    clearTimeout(state.timer);
  };
}

/** Poll only while something is going and this screen is the one in front. */
function usePipelinePolling(answer: VaultPipeline | null): void {
  const focused = useIsFocused();
  const busy = focused && isPipelineBusy(answer);
  useEffect(() => (busy ? pollUntilCancelled() : undefined), [busy]);
}

/** The one sentence for a vault whose half of the answer is missing. */
const VaultReachNotice = ({
  answer,
  navigation,
}: {
  answer: VaultPipeline;
  navigation?: DashboardNavigation;
}): React.JSX.Element | null => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  if (answer.vault_unreachable) {
    return (
      <View style={styles.notice} testID="vault-dashboard-unreachable">
        <Text style={[t.body, styles.paragraph]}>{VAULT_UNREACHABLE}</Text>
        <ManagedVaultReachability />
      </View>
    );
  }
  if (answer.vault_status === 'update_needed') {
    return (
      <View style={styles.notice} testID="vault-dashboard-update-needed">
        <Text style={[t.body, styles.noticeText]}>{VAULT_UPDATE_NEEDED}</Text>
      </View>
    );
  }
  if (answer.vault_status === 'not_connected') {
    return (
      <View style={styles.notice} testID="vault-dashboard-not-connected">
        <Text style={[t.body, styles.paragraph]}>{VAULT_DASHBOARD_NOT_CONNECTED}</Text>
        <Button
          label={VAULT_DASHBOARD_OPEN_SETTINGS}
          variant="secondary"
          onPress={() => navigation?.navigate?.('VaultSettings')}
          testID="vault-dashboard-open-settings"
          style={styles.noticeButton}
        />
      </View>
    );
  }
  return null;
};

/** One import: its heading and counts, then each file and where it went. */
const ReceiptGroupCard = ({ group }: { group: ReceiptGroup }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.card} testID={`vault-upload-group-${group.key}`}>
      <View style={styles.cardHead}>
        <Text style={[t.label, styles.cardTitle]}>{batchHeading(group.kind, group.day)}</Text>
        <Text style={[t.caption, styles.soft, styles.numerals]}>
          {batchCountsLine(group.landed, group.notLanded)}
        </Text>
      </View>
      {group.receipts.map((receipt) => (
        <View key={receipt.id} style={styles.line} testID={`vault-receipt-${String(receipt.id)}`}>
          <Text style={[t.body, styles.name]} numberOfLines={1}>
            {receipt.filename}
          </Text>
          <Text style={[t.caption, styles.soft]}>{receiptLine(receipt)}</Text>
        </View>
      ))}
    </View>
  );
};

/** What came in: the receipts, one card per import. */
const UploadsSection = ({ answer }: { answer: VaultPipeline }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const groups = groupReceipts(answer.recent_uploads, detectDeviceTimezone());
  return (
    <EditorialSection title={VAULT_UPLOADS_HEADING} testID="vault-dashboard-uploads">
      {groups.length === 0 ? (
        <Text style={[t.body, styles.paragraph]}>{VAULT_DASHBOARD_NOTHING_YET}</Text>
      ) : (
        groups.map((group) => <ReceiptGroupCard key={group.key} group={group} />)
      )}
    </EditorialSection>
  );
};

/** One recent file as Creek reports it: where it landed, and each stage it went through. */
const DocumentTrail = ({
  document,
  index,
}: {
  document: VaultDocument;
  index: number;
}): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const trail = document.stages
    .map((stage) => `${documentStageLabel(stage.stage)} ${documentStageMark(stage.outcome)}`)
    .join(' · ');
  return (
    <View
      style={[styles.line, index === 0 ? styles.firstLine : null]}
      testID={`vault-document-${String(index)}`}
    >
      <Text style={[t.body, styles.name]} numberOfLines={1}>
        {document.filename}
      </Text>
      {document.landed_in ? (
        <Text style={[t.caption, styles.soft]}>{landedInLine(document.landed_in)}</Text>
      ) : null}
      <Text style={[t.caption, styles.soft]}>{trail}</Text>
    </View>
  );
};

/** The passes adepthood ran, newest of each stage. */
const PassList = ({ answer }: { answer: VaultPipeline }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const passes = passSummary(answer.stage_runs, answer.vault?.jobs ?? []);
  const newest = answer.stage_runs[0];
  if (passes.length === 0) {
    return <Text style={[t.body, styles.paragraph]}>{VAULT_DASHBOARD_NO_PASSES}</Text>;
  }
  return (
    <View style={styles.card} testID="vault-dashboard-passes">
      {newest ? (
        <Text style={[t.caption, styles.muted, styles.numerals]}>
          {lastPassLine(formatTimeInTZ(new Date(newest.ran_at), detectDeviceTimezone()))}
        </Text>
      ) : null}
      {passes.map((pass) => (
        <Text
          key={pass.stage}
          style={[t.body, styles.passLine, styles.numerals]}
          testID={`vault-pass-${pass.stage}`}
        >
          {passLine(pass)}
        </Text>
      ))}
    </View>
  );
};

/** What Creek has done: the passes, then each recent file's trail. */
const CreekSection = ({ answer }: { answer: VaultPipeline }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const documents = answer.vault?.documents ?? [];
  const withheld = withheldLine(answer.vault?.documents_withheld ?? 0);
  return (
    <EditorialSection title={VAULT_CREEK_HEADING} testID="vault-dashboard-creek">
      <PassList answer={answer} />
      {documents.length > 0 || withheld ? (
        <>
          <Text style={[t.caption, styles.muted, styles.subLabel]}>{VAULT_DOCUMENTS_HEADING}</Text>
          <View style={styles.card}>
            {documents.map((document, index) => (
              <DocumentTrail
                key={`${document.filename}-${String(index)}`}
                document={document}
                index={index}
              />
            ))}
            {withheld ? (
              <Text style={[t.caption, styles.soft]} testID="vault-documents-withheld">
                {withheld}
              </Text>
            ) : null}
          </View>
        </>
      ) : null}
    </EditorialSection>
  );
};

/** One folder: its name and count on one line, and what fills it beneath. */
const FolderRow = ({
  folder,
  first,
}: {
  folder: VaultFolder;
  first: boolean;
}): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const note = folderNote(folder);
  const topLevel = !folder.path.includes('/');
  return (
    <View
      style={[styles.line, first ? styles.firstLine : null]}
      testID={`vault-folder-${folder.path}`}
    >
      <View style={styles.folderHead}>
        <Text style={[t.body, topLevel ? styles.name : styles.folderName, styles.folderLabel]}>
          {folderLabel(folder.path)}
        </Text>
        <Text
          style={[t.body, styles.count, styles.numerals]}
          testID={`vault-folder-count-${folder.path}`}
        >
          {folder.count > 0 ? String(folder.count) : '—'}
        </Text>
      </View>
      {note ? <Text style={[t.caption, styles.soft]}>{note}</Text> : null}
    </View>
  );
};

/** The vault's shape: one row per ontology folder, in Creek's own order. */
const ShapeSection = ({ folders }: { folders: readonly VaultFolder[] }): React.JSX.Element => (
  <EditorialSection title={VAULT_SHAPE_HEADING} testID="vault-dashboard-shape">
    <View style={styles.card}>
      {folders.map((folder, index) => (
        <FolderRow key={folder.path} folder={folder} first={index === 0} />
      ))}
    </View>
  </EditorialSection>
);

/** The first read failed: say so, and offer to read again. */
const ReadFailure = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.notice}>
      <Text style={[t.body, styles.paragraph]} testID="vault-dashboard-read-failure">
        {VAULT_DASHBOARD_READ_FAILURE}
      </Text>
      <Button
        label={VAULT_DASHBOARD_RETRY}
        variant="secondary"
        onPress={onRetry}
        testID="vault-dashboard-retry"
        style={styles.noticeButton}
      />
    </View>
  );
};

/** Everything the answer holds, section by section. */
const DashboardBody = ({
  answer,
  navigation,
}: {
  answer: VaultPipeline;
  navigation?: DashboardNavigation;
}): React.JSX.Element => (
  <>
    <VaultReachNotice answer={answer} navigation={navigation} />
    <UploadsSection answer={answer} />
    <CreekSection answer={answer} />
    {answer.vault ? <ShapeSection folders={answer.vault.folders} /> : null}
  </>
);

/** What the screen shows before and without an answer. */
const DashboardState = ({
  answer,
  failed,
  reading,
  onRetry,
  navigation,
}: {
  answer: VaultPipeline | null;
  failed: boolean;
  reading: boolean;
  onRetry: () => void;
  navigation?: DashboardNavigation;
}): React.JSX.Element => {
  if (answer !== null) return <DashboardBody answer={answer} navigation={navigation} />;
  if (failed && !reading) return <ReadFailure onRetry={onRetry} />;
  return (
    <View style={styles.loading} testID="vault-dashboard-loading">
      <ActivityIndicator color={accent.primary} />
    </View>
  );
};

const VaultDashboardScreen = ({
  navigation,
}: {
  navigation?: DashboardNavigation;
}): React.JSX.Element => {
  const { answer, failed } = useVaultPipeline();
  const { reading, read } = useFocusRead();
  usePipelinePolling(answer);
  return (
    <ScreenScaffold scroll testID="vault-dashboard-screen">
      <ScreenHeader
        eyebrow={CORPUS_GROUP_TITLE}
        title={VAULT_DASHBOARD_TITLE}
        titleHidden
        lead={VAULT_DASHBOARD_LEAD}
      />
      <DashboardState
        answer={answer}
        failed={failed}
        reading={reading}
        onRetry={read}
        navigation={navigation}
      />
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  paragraph: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  soft: {
    color: ink.soft,
  },
  muted: {
    color: ink.muted,
  },
  numerals: {
    fontVariant: ['tabular-nums'],
  },
  notice: {
    backgroundColor: surface.sunken,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: SPACING.lg,
  },
  noticeText: {
    color: ink.primary,
  },
  noticeButton: {
    alignSelf: 'flex-start',
  },
  card: {
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: rhythm.blockGap,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  cardHead: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: SPACING.md,
    marginBottom: SPACING.xs,
  },
  cardTitle: {
    color: ink.primary,
  },
  line: {
    borderTopColor: surface.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: SPACING.sm,
  },
  firstLine: {
    borderTopWidth: 0,
  },
  name: {
    color: ink.primary,
    fontWeight: '600',
  },
  passLine: {
    color: ink.primary,
    marginTop: SPACING.xs,
  },
  subLabel: {
    marginBottom: SPACING.sm,
    marginTop: SPACING.sm,
  },
  folderHead: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    columnGap: SPACING.md,
  },
  folderLabel: {
    flexShrink: 1,
  },
  folderName: {
    color: ink.primary,
  },
  count: {
    color: ink.primary,
    textAlign: 'right',
  },
  loading: {
    alignItems: 'center',
    paddingVertical: rhythm.sectionGap,
  },
});

export default VaultDashboardScreen;
