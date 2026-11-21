/**
 * "Uploading · 37 remaining" -- the upload queue, visible from anywhere in the
 * app (#3772), with "· 3 failed" once any has (#3771).
 *
 * The queue outlives the Seed screen, so something outside that screen has to
 * say it is still going: otherwise a person who moved on to their journal
 * would have documents arriving in their vault that nothing on screen
 * mentions, the very divergence #2426 stopped runs on unmount to avoid. Pressing
 * it opens the run on the seeding screen, where each row says where it got to.
 *
 * Mounted once, beside the offline banner, so it is also where the page warns
 * before a tab close takes the queue with it.
 *
 * Once the queue drains it says, quietly and in the same place, how the one
 * vault pass over what landed is going (#3773): settling, settled, or deferred
 * when the vault was out of reach. That line is not a button -- there is
 * nothing to open and nothing to do.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  SETTLE_DEFERRED_LINE,
  SETTLED_LINE,
  SETTLING_LINE,
  uploadQueueIndicatorLine,
} from './seedCopy';
import { useUnloadWarning } from './useUnloadWarning';

import { accent, SPACING, surface, ink, touchTarget } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';
import {
  selectUploadQueueFailed,
  selectUploadQueueRemaining,
  useUploadQueueStore,
} from '@/store/useUploadQueueStore';
import { useVaultSettleStore, type VaultSettlePhase } from '@/store/useVaultSettleStore';

/** What the indicator says to a screen reader it does when pressed. */
const OPEN_RUN_HINT = "Opens Bring in what you've written, where each document's progress is.";

/** What the line says for each phase of the pass after a drain. */
const SETTLE_LINES: Record<Exclude<VaultSettlePhase, 'idle'>, string> = {
  settling: SETTLING_LINE,
  settled: SETTLED_LINE,
  deferred: SETTLE_DEFERRED_LINE,
};

/** The quiet line about the vault pass after a drain; nothing while there is none. */
function VaultSettleLine(): React.JSX.Element | null {
  const phase = useVaultSettleStore((state) => state.phase);
  if (phase === 'idle') return null;
  return (
    <View style={styles.indicator} accessibilityLiveRegion="polite" testID="vault-settle">
      {phase === 'settling' ? <ActivityIndicator color={accent.primary} size="small" /> : null}
      <Text style={styles.quiet} testID="vault-settle-line">
        {SETTLE_LINES[phase]}
      </Text>
    </View>
  );
}

/** The app-wide indicator of a running upload queue, then of its vault pass; nothing while idle. */
export function UploadQueueIndicator(): React.JSX.Element | null {
  const isSending = useUploadQueueStore((state) => state.isSending);
  const remaining = useUploadQueueStore(selectUploadQueueRemaining);
  const failed = useUploadQueueStore(selectUploadQueueFailed);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  useUnloadWarning(isSending);
  if (!isSending || remaining === 0) return <VaultSettleLine />;
  const line = uploadQueueIndicatorLine(remaining, failed);
  return (
    <TouchableOpacity
      style={styles.indicator}
      onPress={() => navigation.navigate('SeedCorpus')}
      accessibilityRole="button"
      accessibilityLabel={line}
      accessibilityHint={OPEN_RUN_HINT}
      accessibilityLiveRegion="polite"
      testID="upload-queue-indicator"
    >
      <ActivityIndicator color={accent.primary} size="small" />
      <Text style={styles.text} testID="upload-queue-indicator-line">
        {line}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  indicator: {
    alignItems: 'center',
    backgroundColor: surface.sunken,
    borderBottomColor: surface.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: SPACING.sm,
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.lg,
  },
  text: {
    color: ink.primary,
    fontWeight: '600',
  },
  quiet: {
    color: ink.soft,
  },
});
