import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from 'expo-apple-authentication';
import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { LicenseKeyField } from './components/LicenseKeyField';
import { validateLicenseKey } from './licenseKeyValidation';
import { isGoogleAuthConfigured } from './oauthConfig';
import type { SocialAuthView } from './socialFlow';
import { useAppleAuth, useAppleSignInAvailable } from './useAppleAuth';
import { useGoogleAuth } from './useGoogleAuth';

import { Button } from '@/components/Button';
import { GUMROAD_HELP_URL } from '@/config';
import { useTheme } from '@/design/ThemeContext';
import { BORDER_RADIUS } from '@/design/tokens';
import { openExternalUrl } from '@/utils/openExternalUrl';

// Google's button owns its own wording — only three strings are permitted on
// it, so that phrase is a compliance constant living beside the rest of the
// mandated branding, not screen copy this file is free to set.
const APPLE_LABEL = 'Continue with Apple';

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

/**
 * How one provider's license step names itself. Nothing disables the other
 * provider's button, so both steps can be on screen at once: every name and
 * every testID here has to say which provider it belongs to, or voice control
 * and a screen reader are both handed an ambiguity.
 */
interface LicenseStepIds {
  fieldLabel: string;
  helpLabel: string;
  submitLabel: string;
  helpTestID: string;
  errorTestID: string;
  submitTestID: string;
}

/** Scope one provider's license step: shared copy, suffixed with whose step it is. */
function licenseIdsFor(
  provider: string,
  testIdPrefix: string,
  submitTestID: string,
): LicenseStepIds {
  const suffix = `for ${provider} sign-in`;
  return {
    fieldLabel: `Gumroad license key ${suffix}`,
    helpLabel: `Find your license key ${suffix}`,
    submitLabel: `Submit license key ${suffix}`,
    helpTestID: `${testIdPrefix}-license-help`,
    errorTestID: `${testIdPrefix}-license-error`,
    submitTestID,
  };
}

// Google's submit keeps its original, unprefixed testID: it shipped first and
// nothing else answers to it.
const GOOGLE_LICENSE_IDS = licenseIdsFor(
  'Google',
  'social-auth-google',
  'social-auth-license-submit',
);
const APPLE_LICENSE_IDS = licenseIdsFor(
  'Apple',
  'social-auth-apple',
  'social-auth-apple-license-submit',
);

interface LicenseStepProps {
  value: string;
  submitting: boolean;
  ids: LicenseStepIds;
  onChangeText: (_value: string) => void;
  onSubmit: () => void;
}

/**
 * The license key, asked for in place. The provider's prompt already ran and
 * its credential is still held by the hook, so finishing here costs the user
 * one field — never a second trip through the provider, and never a different
 * screen.
 */
function LicenseStep({
  value,
  submitting,
  ids,
  onChangeText,
  onSubmit,
}: LicenseStepProps): React.JSX.Element {
  return (
    <View style={styles.licenseStep}>
      <Text style={styles.licenseStepLead}>
        One more step: add the license key from your Gumroad receipt.
      </Text>
      <LicenseKeyField
        value={value}
        accessibilityLabel={ids.fieldLabel}
        errorTestID={ids.errorTestID}
        helpTestID={ids.helpTestID}
        helpAccessibilityLabel={ids.helpLabel}
        onChangeText={onChangeText}
        onPressHelp={openLicenseHelp}
      />
      <Button
        accessibilityLabel={ids.submitLabel}
        busy={submitting}
        disabled={submitting}
        label={submitting ? 'Checking...' : 'Continue'}
        onPress={onSubmit}
        testID={ids.submitTestID}
      />
    </View>
  );
}

interface ProviderFlowProps {
  state: SocialAuthView & { submitLicenseKey: (_key: string) => void };
  /**
   * The provider's own button. Both are drawn to their owner's mandatory
   * guidelines: Apple's is Apple's own component, Google's is ours to render but
   * theirs to specify — neither is the app's to style.
   */
  button: React.ReactNode;
  errorTestID: string;
  license: LicenseStepIds;
}

/**
 * One provider's column: its button, its single error slot, and its inline
 * license step. Shared by both providers so the two flows cannot drift apart in
 * behaviour or in what a screen reader hears.
 */
function ProviderFlow({
  state,
  button,
  errorTestID,
  license,
}: ProviderFlowProps): React.JSX.Element {
  const [licenseKey, setLicenseKey] = useState('');
  const [invalidKey, setInvalidKey] = useState<string | null>(null);

  const handleChangeKey = (value: string): void => {
    setLicenseKey(value);
    setInvalidKey(null);
  };

  const handleSubmitKey = (): void => {
    const invalid = validateLicenseKey(licenseKey);
    setInvalidKey(invalid);
    if (invalid === null) state.submitLicenseKey(licenseKey);
  };

  // One error slot per provider, so a screen reader is never handed two
  // competing alerts. The local complaint wins: it is about what the user just
  // typed.
  const message = invalidKey ?? state.error;

  return (
    <>
      {button}
      {message === null ? null : (
        <Text
          // Appears in place with no mount cue, so pair the role with a live
          // region — and never rely on the colour alone to carry the message.
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.error}
          testID={errorTestID}
        >
          {message}
        </Text>
      )}
      {state.status === 'needsLicense' ? (
        <LicenseStep
          value={licenseKey}
          submitting={state.submitting}
          ids={license}
          onChangeText={handleChangeKey}
          onSubmit={handleSubmitKey}
        />
      ) : null}
    </>
  );
}

/**
 * The configured half of the Google option — split into its own component so
 * the auth hook only ever runs in a build that can actually complete the flow.
 */
function GoogleSignIn(): React.JSX.Element {
  const state = useGoogleAuth();
  return (
    <ProviderFlow
      state={state}
      errorTestID="social-auth-error"
      license={GOOGLE_LICENSE_IDS}
      button={
        <GoogleSignInButton
          onPress={state.signIn}
          submitting={state.submitting}
          testID="social-auth-google"
        />
      }
    />
  );
}

/**
 * The Apple option, mounted only where the platform supports it.
 *
 * The mark is Apple's own component, as their HIG and the App Store guidelines
 * require — never a facsimile — which also means we do not get a ``disabled``
 * prop, so the in-flight guard lives in the press handler instead. The style
 * flips with the theme so the mark always contrasts with the canvas behind it.
 */
function AppleSignIn(): React.JSX.Element {
  const state = useAppleAuth();
  const { mode } = useTheme();

  const handlePress = (): void => {
    if (!state.submitting) state.signIn();
  };

  return (
    <ProviderFlow
      state={state}
      errorTestID="social-auth-apple-error"
      license={APPLE_LICENSE_IDS}
      button={
        <AppleAuthenticationButton
          accessibilityLabel={APPLE_LABEL}
          buttonType={AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={
            mode === 'dark'
              ? AppleAuthenticationButtonStyle.WHITE
              : AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={BORDER_RADIUS.lg}
          onPress={handlePress}
          style={styles.appleButton}
          testID="social-auth-apple"
        />
      }
    />
  );
}

/**
 * The social sign-in options, offered beside — never above — the email form.
 *
 * Each provider draws only where it can actually finish: Google needs a client
 * ID for this platform (which doubles as its rollout switch), Apple needs a
 * platform that supports Sign in with Apple. An absent provider leaves no gap
 * and no dead control, and with neither available the whole aside disappears
 * and email is the only path. Both gates are read before any provider hook
 * mounts, so an unconfigured build never reaches the provider SDK.
 */
export function SocialAuthButtons(): React.JSX.Element | null {
  const appleAvailable = useAppleSignInAvailable();
  const googleConfigured = isGoogleAuthConfigured();
  if (!googleConfigured && !appleAvailable) return null;

  return (
    <View style={styles.socialSection}>
      <AuthDivider />
      {googleConfigured ? <GoogleSignIn /> : null}
      {appleAvailable ? <AppleSignIn /> : null}
    </View>
  );
}
