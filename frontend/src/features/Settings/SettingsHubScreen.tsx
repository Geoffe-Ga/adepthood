import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  BookOpen,
  Download,
  FileText,
  FolderUp,
  Globe,
  KeyRound,
  LifeBuoy,
  LogOut,
  ShieldCheck,
  Trash2,
  Vault,
} from 'lucide-react-native';
import React, { useCallback } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { CORPUS_CONSENT_ROW_DESCRIPTION, CORPUS_CONSENT_ROW_LABEL } from './corpusConsentCopy';
import { LEGAL_DOCUMENTS } from './legalLinks';
import { SettingsRow } from './shared/SettingsRow';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { useAuth } from '@/context/AuthContext';
import { accent, ink, rhythm, type as typeRamp } from '@/design/tokens';
import ChooseDepthsSection from '@/features/Settings/ChooseDepthsSection';
import SanghaSection from '@/features/Settings/SanghaSection';
import { VAULT_ROW_DESCRIPTION, VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';
import type { RootStackParamList } from '@/navigation/RootStack';
import { openExternalUrl } from '@/utils/openExternalUrl';

/**
 * Warm Settings landing hub (#835). Groups the scattered settings entries —
 * Account (API key, time zone) and Session (log out) — as warm editorial rows
 * on the shared scaffold. The header-right gear points here (not at a single
 * sub-screen); logout moved off the tab header and lives in the Session group.
 */

const ICON_SIZE = 22;

/** Entry-visibility promise: the three privacy tiers are the user's choice. */
const PRIVACY_VISIBILITY_LINE =
  'You choose the privacy of every entry — Public, Personal, or Intimate.';
/** The hard guarantee that Intimate entries are never shared with any model. */
const PRIVACY_INTIMATE_LINE = 'Entries you mark Intimate are never sent to any AI.';
/** Full-sentence a11y label so screen-reader users hear both promises at once. */
const PRIVACY_A11Y_LABEL = `${PRIVACY_VISIBILITY_LINE} ${PRIVACY_INTIMATE_LINE}`;

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
 * Privacy group: an informational statement surfacing the entry-visibility
 * tiers and the Intimate/AI guarantee as a first-class feature rather than a
 * buried setting. The statement block itself stays non-interactive — it makes a
 * promise, it is not a destination — while the group also hosts the private
 * vault destination, because where a copy of your journal may go is part of the
 * same privacy story.
 */
const PrivacySection = ({ onVault }: { onVault: () => void }): React.JSX.Element => {
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
      <SettingsRow
        icon={Vault}
        label={VAULT_ROW_LABEL}
        description={VAULT_ROW_DESCRIPTION}
        onPress={onVault}
        testID="settings-row-vault"
      />
    </EditorialSection>
  );
};

interface CorpusSectionProps {
  onSeedCorpus: () => void;
  onCorpusConsent: () => void;
}

/**
 * Corpus group: the way in for writing that already exists elsewhere, and the
 * decision about whether any of it is sorted for reflections to draw on.
 * Phrased as an offer, not a task — the journal works fine on its own, and both
 * rows only widen what reflections can reach for people who want that. The
 * consent row is off until somebody turns it on, so it is a question rather
 * than a setting to correct.
 */
const CorpusSection = ({
  onSeedCorpus,
  onCorpusConsent,
}: CorpusSectionProps): React.JSX.Element => (
  <EditorialSection title="Your corpus" testID="settings-group-corpus">
    <SettingsRow
      icon={FolderUp}
      label="Bring in your writing"
      description="Add notes, exports, and documents you have already written elsewhere."
      onPress={onSeedCorpus}
      testID="settings-row-seed-corpus"
    />
    <SettingsRow
      icon={BookOpen}
      label={CORPUS_CONSENT_ROW_LABEL}
      description={CORPUS_CONSENT_ROW_DESCRIPTION}
      onPress={onCorpusConsent}
      testID="settings-row-corpus-consent"
    />
  </EditorialSection>
);

/**
 * Your data group: the copy you can take away. It sits above Session on
 * purpose -- deletion is down there, and the only honest order is "here is how
 * to keep your writing" before "here is how to destroy it".
 */
const YourDataSection = ({ onExportData }: { onExportData: () => void }): React.JSX.Element => (
  <EditorialSection title="Your data" testID="settings-group-your-data">
    <SettingsRow
      icon={Download}
      label="Export my data"
      description="Download everything you have written, as JSON and as a readable journal."
      onPress={onExportData}
      testID="settings-row-export-data"
    />
  </EditorialSection>
);

interface SessionSectionProps {
  onLogout: () => void;
  onDeleteAccount: () => void;
}

/**
 * Session group: the destructive log-out action, and below it the permanent
 * one. Account deletion lives here rather than behind a support email because
 * App Store Guideline 5.1.1(v) requires the path to be inside the app — and
 * because a journal you cannot leave is not one you fully own.
 */
const SessionSection = ({ onLogout, onDeleteAccount }: SessionSectionProps): React.JSX.Element => (
  <EditorialSection title="Session" testID="settings-group-session">
    <SettingsRow
      icon={LogOut}
      label="Log out"
      description="Sign out of Adepthood on this device."
      onPress={onLogout}
      testID="settings-row-logout"
      destructive
    />
    <SettingsRow
      icon={Trash2}
      label="Delete account"
      description="Erase your account and everything in it. This cannot be undone."
      onPress={onDeleteAccount}
      testID="settings-row-delete-account"
      destructive
    />
  </EditorialSection>
);

/**
 * Legal group: the privacy policy and the terms, opened in the platform
 * browser. They are read outside the app on purpose — they are hosted
 * independently of this project's API, so they stay readable when it is not.
 */
const LegalSection = (): React.JSX.Element => (
  <EditorialSection title="Legal" testID="settings-group-legal">
    {LEGAL_DOCUMENTS.map((document) => (
      <SettingsRow
        key={document.id}
        icon={FileText}
        label={document.label}
        description={document.description}
        onPress={() => void openExternalUrl(document.url)}
        testID={document.testID}
      />
    ))}
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
  const openVault = useCallback(() => navigation.navigate('VaultSettings'), [navigation]);
  const openSeedCorpus = useCallback(() => navigation.navigate('SeedCorpus'), [navigation]);
  const openExportData = useCallback(() => navigation.navigate('ExportData'), [navigation]);
  const openCorpusConsent = useCallback(() => navigation.navigate('CorpusConsent'), [navigation]);
  const openDeleteAccount = useCallback(() => navigation.navigate('DeleteAccount'), [navigation]);
  const onLogout = useCallback(() => void logout(), [logout]);

  return (
    <ScreenScaffold scroll testID="settings-hub-screen">
      <ScreenHeader
        eyebrow="Your account"
        title="Settings"
        lead="Manage how Adepthood works for you."
      />
      <AccountSection onApiKey={openApiKey} onTimezone={openTimezone} />
      <CorpusSection onSeedCorpus={openSeedCorpus} onCorpusConsent={openCorpusConsent} />
      <PrivacySection onVault={openVault} />
      <ChooseDepthsSection />
      <SanghaSection />
      <YourDataSection onExportData={openExportData} />
      <SessionSection onLogout={onLogout} onDeleteAccount={openDeleteAccount} />
      <SupportSection onSupportCare={openSupportCare} />
      <LegalSection />
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
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
