/**
 * Where each file of a Seed run landed (#3776): the receipt on a landed row
 * ("Landed in Writing · Substack"), and, once the run is done, the way to the
 * "Your vault" dashboard that says what Creek has done with them.
 *
 * Kept apart from the run itself on purpose. The run's state machine knows a
 * row's name and status and nothing else, and these read the dashboard's own
 * receipts (``GET /vault/pipeline``) through the store the dashboard shares, so
 * the row and the dashboard it links to can never disagree.
 *
 * A row claims a folder only when the receipts say so unambiguously (see
 * :func:`landedFolderFor`): a vault that cannot say yet, or two files of one
 * name in different folders, leave the row's own "in your vault" line to speak.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import type { SeedItem } from './seedRun';

import { accent, ink, SPACING, touchTarget } from '@/design/tokens';
import { refreshVaultPipeline, useVaultPipeline } from '@/features/Settings/useVaultPipeline';
import { landedInLine, SEED_SEE_WHERE_LABEL } from '@/features/Settings/vaultDashboardCopy';
import { landedFolderFor } from '@/features/Settings/vaultDashboardModel';
import type { RootStackParamList } from '@/navigation/RootStack';

/** The run status a vault answers a document it took with. */
const VAULT_LANDED = 'ingested';

/** "Landed in Writing · Substack" under a landed row, when the receipts can say. */
export const SeedRowLanding = ({ item }: { item: SeedItem }): React.JSX.Element | null => {
  const { answer } = useVaultPipeline();
  if (item.status !== VAULT_LANDED || answer === null) return null;
  const folder = landedFolderFor(answer.recent_uploads, item.name);
  if (folder === null) return null;
  return (
    <Text style={styles.landed} testID={`seed-item-landed-${item.id}`}>
      {landedInLine(folder)}
    </Text>
  );
};

/**
 * Once a run has finished with something in the vault: read the receipts (so
 * the rows above can say where each landed) and offer the dashboard. Read again
 * whenever more have landed, never while documents are still going over.
 */
export const SeedVaultReceiptsLink = ({
  items,
  isSending,
}: {
  items: readonly SeedItem[];
  isSending: boolean;
}): React.JSX.Element | null => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const landed = items.filter((item) => item.status === VAULT_LANDED).length;
  const finished = !isSending && landed > 0;
  useEffect(() => {
    if (finished) void refreshVaultPipeline();
  }, [finished, landed]);
  if (!finished) return null;
  return (
    <TouchableOpacity
      onPress={() => navigation.navigate('VaultDashboard')}
      accessibilityRole="button"
      accessibilityLabel={SEED_SEE_WHERE_LABEL}
      style={styles.link}
      testID="seed-open-vault-dashboard"
    >
      <Text style={styles.linkText}>{SEED_SEE_WHERE_LABEL}</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  landed: {
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  link: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginTop: SPACING.sm,
    minHeight: touchTarget.minimum,
  },
  linkText: {
    color: accent.primary,
    fontWeight: '600',
  },
});
