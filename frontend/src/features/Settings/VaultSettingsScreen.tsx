/**
 * ``VaultSettingsScreen`` — the informational "Your private vault" destination,
 * reached from the Privacy group in Settings.
 *
 * Deliberately inert. A vault is configured where it runs rather than from the
 * app, and the app is given no way to read whether one is attached — so a
 * connect control would have nothing to call and a "connected" badge would be a
 * claim this screen cannot stand behind. It states one promise, explains what a
 * vault is, says outright that Adepthood is complete without one, and stops
 * there: declining is a whole way to use the app, not an unfinished setup step.
 */
import React from 'react';
import { StyleSheet, Text, useWindowDimensions } from 'react-native';

import {
  VAULT_EYEBROW,
  VAULT_FLOOR,
  VAULT_INTIMATE,
  VAULT_PROMISE,
  VAULT_SETUP,
  VAULT_TITLE,
  VAULT_WHAT_IT_IS,
} from './vaultCopy';

import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';

const VaultSettingsScreen = (): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <ScreenScaffold scroll testID="vault-settings-screen">
      <ScreenHeader
        eyebrow={VAULT_EYEBROW}
        title={VAULT_TITLE}
        lead={VAULT_PROMISE}
        testID="vault-promise"
      />
      <Text style={[t.body, styles.body]} testID="vault-what-it-is">
        {VAULT_WHAT_IT_IS}
      </Text>
      {/* No explicit label: the floor states its own optionality, and repeating
          the header's promise here would announce it twice in reading order. */}
      <Text style={[t.body, styles.body]} accessibilityRole="text" testID="vault-floor">
        {VAULT_FLOOR}
      </Text>
      <Text style={[t.caption, styles.caption]} testID="vault-intimate">
        {VAULT_INTIMATE}
      </Text>
      <Text style={[t.caption, styles.caption]} testID="vault-setup">
        {VAULT_SETUP}
      </Text>
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  body: {
    color: ink.primary,
    marginBottom: rhythm.sectionGap,
  },
  caption: {
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
});

export default VaultSettingsScreen;
