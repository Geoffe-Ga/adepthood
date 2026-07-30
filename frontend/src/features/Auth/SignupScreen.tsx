import React from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthBrandBand } from './AuthBrandBand';
import { AuthScreenContainer } from './AuthScreenContainer';
import { EmailField } from './components/EmailField';
import { LicenseKeyField } from './components/LicenseKeyField';
import { PasswordField } from './components/PasswordField';
import { SocialAuthButtons } from './SocialAuthButtons';
import { useSignupForm } from './useSignupForm';
import type { SignupForm } from './useSignupForm';

import { Button } from '@/components/Button';
import { GUMROAD_HELP_URL } from '@/config';
import { openExternalUrl } from '@/utils/openExternalUrl';

interface Props {
  navigation: { navigate: (_screen: string) => void };
  /**
   * Optional so callers that only pass ``navigation`` still type-check. A
   * supplied ``licenseKey`` seeds the field — the seam a post-purchase deep
   * link or a later social-auth flow reuses.
   */
  route?: { params?: { licenseKey?: string } };
}

interface SignupFieldsProps {
  form: SignupForm;
  onPressHelp: () => void;
}

function SignupFields({ form, onPressHelp }: SignupFieldsProps): React.JSX.Element {
  return (
    <>
      <EmailField
        accessibilityLabel="Email"
        style={styles.inputSpacing}
        value={form.email}
        onChangeText={form.setEmail}
      />
      <PasswordField
        accessibilityLabel="Password"
        style={styles.inputSpacing}
        value={form.password}
        onChangeText={form.setPassword}
      />
      <PasswordField
        accessibilityLabel="Confirm password"
        style={styles.inputSpacing}
        placeholder="Confirm Password"
        value={form.confirmPassword}
        onChangeText={form.setConfirmPassword}
      />
      <LicenseKeyField
        error={form.licenseError}
        onPressHelp={onPressHelp}
        value={form.licenseKey}
        onChangeText={form.setLicenseKey}
      />
    </>
  );
}

interface SignupActionsProps {
  onSignup: () => void;
  onNavigateLogin: () => void;
  submitting: boolean;
}

function SignupActions({ onSignup, onNavigateLogin, submitting }: SignupActionsProps) {
  return (
    <>
      <Button
        accessibilityLabel="Create account"
        style={styles.buttonSpacing}
        onPress={onSignup}
        disabled={submitting}
        busy={submitting}
        testID="signup-submit"
        label={submitting ? 'Creating account...' : 'Sign Up'}
      />
      <TouchableOpacity
        accessibilityLabel="Go to log-in screen"
        accessibilityRole="link"
        onPress={onNavigateLogin}
      >
        <Text style={styles.link}>
          Already have an account? <Text style={styles.linkBold}>Log In</Text>
        </Text>
      </TouchableOpacity>
    </>
  );
}

export default function SignupScreen({ navigation, route }: Props) {
  const form = useSignupForm(route?.params?.licenseKey ?? '');

  // The help page is static config: appending the typed key would leak a
  // credential into the browser URL bar, history and referrer header.
  // ``openExternalUrl`` reports its own failures, so the form surfaces nothing.
  const handlePressHelp = (): void => {
    void openExternalUrl(GUMROAD_HELP_URL).catch(() => undefined);
  };

  return (
    <AuthScreenContainer testID="signup">
      <AuthBrandBand />
      <Text style={styles.title}>Begin</Text>
      <Text style={styles.lead}>Create your account and start the practice.</Text>
      <SignupFields form={form} onPressHelp={handlePressHelp} />
      {form.error && (
        <Text style={styles.error} testID="signup-error">
          {form.error}
        </Text>
      )}
      <SignupActions
        onSignup={form.handleSignup}
        onNavigateLogin={() => navigation.navigate('Login')}
        submitting={form.submitting}
      />
      {/* Below the primary action on purpose: an offered option, not a push. */}
      <SocialAuthButtons />
    </AuthScreenContainer>
  );
}
