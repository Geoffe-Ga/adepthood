import { MessagesSquare } from 'lucide-react-native';
import React, { useCallback } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  SANGHA_DECLINE_HINT,
  SANGHA_LEAD,
  SANGHA_ROW_DESCRIPTION,
  SANGHA_ROW_LABEL,
  SANGHA_SECTION_TITLE,
  sanghaInviteUrl,
} from './sanghaInvite';
import { SettingsRow } from './shared/SettingsRow';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { SANGHA_INVITE_URL } from '@/config';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';
import { selectEnableSangha, useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';
import { openExternalUrl } from '@/utils/openExternalUrl';

/**
 * The Digital Sangha's whole front door: one Settings row that hands the
 * reader to Discord, wrapped in the sentence explaining that going is
 * optional.
 *
 * It renders only when both halves of "you choose your depth" hold. The
 * Sangha ring has to still be open — the switch in the Choose-your-depths
 * section above is the single mechanism for closing it, and because that
 * choice is stored server-side it is still closed on the next cold start,
 * without this component knowing anything about persistence. And an invite
 * has to be configured, or there is nothing worth showing a door to.
 *
 * Deliberately absent: any badge, member count, unread marker, or prompt
 * anywhere outside Settings. Settings is a place a person goes looking; an
 * interstitial is a place that comes looking for them, and the Sangha is not
 * allowed to do that.
 *
 * The section does not fetch depth preferences, matching every other
 * ring-gated surface (``BottomTabs``, ``DrawerNavSection``, ``StatTileRow``).
 * The tab shell loads them when the app opens and the Choose-your-depths
 * section refreshes them on this screen, so by the time Settings is reachable
 * the store is authoritative; a third read here would only duplicate a request
 * for state already in hand.
 */
const SanghaSection = (): React.JSX.Element | null => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const enabled = useDepthPreferencesStore(selectEnableSangha);
  // Read at render, not at import: the invite is meant to be replaceable
  // without a store release.
  const url = sanghaInviteUrl(SANGHA_INVITE_URL);

  const open = useCallback(() => {
    if (url !== null) void openExternalUrl(url);
  }, [url]);

  if (!enabled || url === null) {
    return null;
  }

  return (
    <EditorialSection title={SANGHA_SECTION_TITLE} testID="settings-group-sangha">
      <View accessibilityRole="text" testID="sangha-invitation">
        <Text style={[t.body, styles.lead]}>{SANGHA_LEAD}</Text>
        <Text style={[t.caption, styles.hint]}>{SANGHA_DECLINE_HINT}</Text>
      </View>
      <SettingsRow
        icon={MessagesSquare}
        label={SANGHA_ROW_LABEL}
        description={SANGHA_ROW_DESCRIPTION}
        onPress={open}
        testID="settings-row-sangha-discord"
      />
    </EditorialSection>
  );
};

const styles = StyleSheet.create({
  lead: {
    color: ink.primary,
  },
  hint: {
    color: ink.soft,
    marginTop: rhythm.blockGap / 3,
    marginBottom: rhythm.blockGap,
  },
});

export default SanghaSection;
