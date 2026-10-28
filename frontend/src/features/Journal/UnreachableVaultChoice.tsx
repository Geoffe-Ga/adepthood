/**
 * ``UnreachableVaultChoice`` — the way out when a page's vault copy cannot be
 * confirmed gone (#3094).
 *
 * Shown under the shelf's refusal notice after a delete answers one of the
 * withdrawal 503s. A recorded destination offers reconnect first. An unrecorded
 * destination cannot be identified by reconnecting, so it omits that action. The other action
 * is the "I can't reach it" path, explained before it is offered, which deletes
 * the page here only and leaves the plain receipt to say what may remain.
 * Nothing here claims a vault copy is gone.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  UNREACHABLE_ERASE_EXPLAINER,
  UNREACHABLE_ERASE_LABEL,
  UNREACHABLE_RECONNECT_LABEL,
} from './deleteEntryCopy';

import type { CopyLocation } from '@/api';
import { Button } from '@/components/Button';
import { SPACING, colors, editorialType } from '@/design/tokens';

export interface UnreachableVaultChoiceProps {
  location: CopyLocation | null;
  onReconnect: () => void;
  onEraseHere: () => void;
}

function UnreachableVaultChoice({
  location,
  onReconnect,
  onEraseHere,
}: UnreachableVaultChoiceProps): React.JSX.Element | null {
  if (location === null) return null;
  return (
    <View style={styles.panel} testID="journal-unreachable-choice">
      {location !== 'unrecorded_vault' ? (
        <Button
          label={UNREACHABLE_RECONNECT_LABEL}
          onPress={onReconnect}
          variant="primary"
          testID="journal-unreachable-reconnect"
        />
      ) : null}
      <Text style={styles.explainer} testID="journal-unreachable-explainer">
        {UNREACHABLE_ERASE_EXPLAINER}
      </Text>
      <Button
        label={UNREACHABLE_ERASE_LABEL}
        onPress={onEraseHere}
        variant="secondary"
        testID="journal-unreachable-erase"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    gap: SPACING.sm,
  },
  explainer: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
});

export default UnreachableVaultChoice;
