import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { LicenseKeyField } from './components/LicenseKeyField';
import { validateLicenseKey } from './licenseKeyValidation';
import { isGoogleAuthConfigured } from './oauthConfig';
import { useGoogleAuth } from './useGoogleAuth';

import { Button } from '@/components/Button';
import { GUMROAD_HELP_URL } from '@/config';
import { openExternalUrl } from '@/utils/openExternalUrl';

const GOOGLE_LABEL = 'Continue with Google';

/** The help page is static config — appending the typed key would leak it into browser history. */
function openLicenseHelp(): void {
  void openExternalUrl(GUMROAD_HELP_URL).catch(() => undefined);
}

/** Hairline rule with a quiet "or": this is an aside, not a second headline. */
function AuthDivider(): React.JSX.Element {
  return (
    <View style={styles.dividerRow}>
      <View style={styles.dividerRule} />
      <Text style={styles.dividerLabel}>or</Text>
      <View style={styles.dividerRule} />
    </View>
  );
}

interface LicenseStepProps {
  value: string;
  submitting: boolean;
  onChangeText: (_value: string) => void;
  onSubmit: () => void;
}

/**
 * The license key, asked for in place. The Google prompt already ran and its
 * token is still held by the hook, so finishing here costs the user one field —
 * never a second trip through Google, and never a different screen.
 */
function LicenseStep({
  value,
  submitting,
  onChangeText,
  onSubmit,
}: LicenseStepProps): React.JSX.Element {
  return (
    <View style={styles.licenseStep}>
      <Text style={styles.licenseStepLead}>
        One more step: add the license key from your Gumroad receipt.
      </Text>
      <LicenseKeyField value={value} onChangeText={onChangeText} onPressHelp={openLicenseHelp} />
      <Button
        accessibilityLabel="Submit license key"
        busy={submitting}
        disabled={submitting}
        label={submitting ? 'Checking...' : 'Continue'}
        onPress={onSubmit}
        testID="social-auth-license-submit"
      />
    </View>
  );
}

/**
 * The configured half of {@link SocialAuthButtons} — split out so the auth hook
 * only ever runs in a build that can actually complete the flow.
 */
function GoogleSignIn(): React.JSX.Element {
  const { status, error, submitting, signIn, submitLicenseKey } = useGoogleAuth();
  const [licenseKey, setLicenseKey] = useState('');
  const [invalidKey, setInvalidKey] = useState<string | null>(null);

  const handleChangeKey = (value: string): void => {
    setLicenseKey(value);
    setInvalidKey(null);
  };

  const handleSubmitKey = (): void => {
    const invalid = validateLicenseKey(licenseKey);
    setInvalidKey(invalid);
    if (invalid === null) submitLicenseKey(licenseKey);
  };

  // One error slot, so a screen reader is never handed two competing alerts.
  // The local complaint wins: it is about what the user just typed.
  const message = invalidKey ?? error;

  return (
    <View style={styles.socialSection}>
      <AuthDivider />
      <Button
        accessibilityLabel={GOOGLE_LABEL}
        busy={submitting}
        disabled={submitting}
        label={submitting ? 'Connecting...' : GOOGLE_LABEL}
        onPress={signIn}
        testID="social-auth-google"
        variant="secondary"
      />
      {message === null ? null : (
        <Text
          // Appears in place with no mount cue, so pair the role with a live
          // region — and never rely on the colour alone to carry the message.
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.error}
          testID="social-auth-error"
        >
          {message}
        </Text>
      )}
      {status === 'needsLicense' ? (
        <LicenseStep
          value={licenseKey}
          submitting={submitting}
          onChangeText={handleChangeKey}
          onSubmit={handleSubmitKey}
        />
      ) : null}
    </View>
  );
}

/**
 * "Continue with Google", offered beside — never above — the email form.
 *
 * Renders nothing at all when this platform has no Google client ID: an
 * unconfigured build hides the option rather than shipping a control that
 * fails on tap, which doubles as the rollout switch. The config check happens
 * here, before any hook, so an unconfigured build never reaches the provider.
 */
export function SocialAuthButtons(): React.JSX.Element | null {
  if (!isGoogleAuthConfigured()) return null;
  return <GoogleSignIn />;
}
