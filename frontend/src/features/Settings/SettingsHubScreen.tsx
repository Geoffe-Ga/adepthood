import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ChevronRight,
  Globe,
  KeyRound,
  LifeBuoy,
  LogOut,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react-native';
import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { useAuth } from '@/context/AuthContext';
import { accent, ink, rhythm, surface, touchTarget, type as typeRamp } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

/**
 * Warm Settings landing hub (#835). Groups the scattered settings entries —
 * Account (API key, time zone) and Session (log out) — as warm editorial rows
 * on the shared scaffold. The header-right gear points here (not at a single
 * sub-screen); logout moved off the tab header and lives in the Session group.
 */

const ICON_SIZE = 22;
const CHEVRON_SIZE = 20;

/** Entry-visibility promise: the three privacy tiers are the user's choice. */
const PRIVACY_VISIBILITY_LINE =
  'You choose the privacy of every entry — Public, Personal, or Intimate.';
/** The hard guarantee that Intimate entries are never shared with any model. */
const PRIVACY_INTIMATE_LINE = 'Entries you mark Intimate are never sent to any AI.';
/** Full-sentence a11y label so screen-reader users hear both promises at once. */
const PRIVACY_A11Y_LABEL = `${PRIVACY_VISIBILITY_LINE} ${PRIVACY_INTIMATE_LINE}`;

interface SettingsRowProps {
  icon: LucideIcon;
  label: string;
  description: string;
  onPress: () => void;
  testID: string;
  destructive?: boolean;
}

const SettingsRow = ({
  icon: Icon,
  label,
  description,
  onPress,
  testID,
  destructive = false,
}: SettingsRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const tint = destructive ? accent.strong : accent.primary;
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      testID={testID}
    >
      <Icon color={tint} size={ICON_SIZE} />
      <View style={styles.rowText}>
        <Text style={[t.label, styles.rowLabel]}>{label}</Text>
        <Text style={[t.caption, styles.rowDescription]}>{description}</Text>
      </View>
      {destructive ? null : <ChevronRight color={ink.muted} size={CHEVRON_SIZE} />}
    </TouchableOpacity>
  );
};

interface AccountSectionProps {
  onApiKey: () => void;
  onTimezone: () => void;
}

/** Account group: the bring-your-own-key and time-zone destinations. */
const AccountSection = ({ onApiKey, onTimezone }: AccountSectionProps): React.JSX.Element => (
  <EditorialSection title="Account" testID="settings-group-account">
    <SettingsRow
      icon={KeyRound}
      label="API key"
      description="Bring your own BotMason API key, stored on this device."
      onPress={onApiKey}
      testID="settings-row-api-key"
    />
    <SettingsRow
      icon={Globe}
      label="Time zone"
      description="Set the zone streaks and daily stats count days in."
      onPress={onTimezone}
      testID="settings-row-timezone"
    />
  </EditorialSection>
);

/**
 * Privacy group: a non-interactive, informational statement surfacing the
 * entry-visibility tiers and the Intimate/AI guarantee as a first-class feature
 * rather than a buried setting. Kept non-navigational — it makes a promise, it
 * is not a destination.
 */
const PrivacySection = (): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <EditorialSection title="Privacy" testID="settings-group-privacy">
      <View
        style={styles.privacyStatement}
        accessibilityRole="text"
        accessibilityLabel={PRIVACY_A11Y_LABEL}
        testID="settings-privacy-statement"
      >
        <ShieldCheck color={accent.primary} size={ICON_SIZE} />
        <View style={styles.privacyText}>
          <Text style={[t.body, styles.privacyLine]}>{PRIVACY_VISIBILITY_LINE}</Text>
          <Text style={[t.caption, styles.privacyLineSoft]}>{PRIVACY_INTIMATE_LINE}</Text>
        </View>
      </View>
    </EditorialSection>
  );
};

/** Session group: the destructive log-out action. */
const SessionSection = ({ onLogout }: { onLogout: () => void }): React.JSX.Element => (
  <EditorialSection title="Session" testID="settings-group-session">
    <SettingsRow
      icon={LogOut}
      label="Log out"
      description="Sign out of Adepthood on this device."
      onPress={onLogout}
      testID="settings-row-logout"
      destructive
    />
  </EditorialSection>
);

/** Always-available Support & care destination (issue #892). */
const SupportSection = ({ onSupportCare }: { onSupportCare: () => void }): React.JSX.Element => (
  <EditorialSection title="Support & care" testID="settings-group-support">
    <SettingsRow
      icon={LifeBuoy}
      label="Support & care"
      description="Reach a person — crisis lines and professional care, any time."
      onPress={onSupportCare}
      testID="settings-row-support"
    />
  </EditorialSection>
);

const SettingsHubScreen = (): React.JSX.Element => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { logout } = useAuth();

  const openApiKey = useCallback(() => navigation.navigate('ApiKeySettings'), [navigation]);
  const openTimezone = useCallback(() => navigation.navigate('TimezoneSettings'), [navigation]);
  const openSupportCare = useCallback(() => navigation.navigate('SupportCare'), [navigation]);
  const onLogout = useCallback(() => void logout(), [logout]);

  return (
    <ScreenScaffold scroll testID="settings-hub-screen">
      <ScreenHeader
        eyebrow="Your account"
        title="Settings"
        lead="Manage how Adepthood works for you."
      />
      <AccountSection onApiKey={openApiKey} onTimezone={openTimezone} />
      <PrivacySection />
      <SessionSection onLogout={onLogout} />
      <SupportSection onSupportCare={openSupportCare} />
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.minimum,
    paddingVertical: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowText: {
    flex: 1,
    marginLeft: rhythm.blockGap,
  },
  rowLabel: {
    color: ink.primary,
  },
  rowDescription: {
    color: ink.soft,
    marginTop: rhythm.blockGap / 3,
  },
  privacyStatement: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: rhythm.blockGap,
  },
  privacyText: {
    flex: 1,
    marginLeft: rhythm.blockGap,
  },
  privacyLine: {
    color: ink.primary,
  },
  privacyLineSoft: {
    color: ink.soft,
    marginTop: rhythm.blockGap / 3,
  },
});

export default SettingsHubScreen;
