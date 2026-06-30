import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ChevronRight,
  Globe,
  KeyRound,
  LifeBuoy,
  LogOut,
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
});

export default SettingsHubScreen;
