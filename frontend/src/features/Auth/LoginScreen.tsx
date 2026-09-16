import React, { useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthBrandBand } from './AuthBrandBand';
import { AuthScreenContainer } from './AuthScreenContainer';
import { canonicalizeEmail } from './canonicalizeEmail';
import { AuthErrorBanner } from './components/AuthErrorBanner';
import { EmailField } from './components/EmailField';
import { PasswordField } from './components/PasswordField';
import { REQUIRED_FIELD_HINT } from './requiredFieldValidation';
import { SocialAuthButtons } from './SocialAuthButtons';
import { useAuthSubmit } from './useAuthSubmit';

import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';

// Names no cause. The transport layer already diagnoses a real network failure
// on its own evidence, and a status the server did classify now reaches the
// screen ahead of this string -- so anything still landing here is a failure we
// cannot honestly attribute, and saying so beats guessing "your connection".
const LOGIN_FALLBACK = "We couldn't sign you in. Give it a moment, then try again.";

/** Field labels: the guard's message names them, so they are user-facing copy. */
const EMAIL_FIELD = 'email';
const PASSWORD_FIELD = 'password'; // pragma: allowlist secret -- a field label, not a credential

interface Props {
  navigation: { navigate: (_screen: string) => void };
}

interface LoginFieldsProps {
  email: string;
  setEmail: (_v: string) => void;
  password: string;
  setPassword: (_v: string) => void;
  missing: ReadonlySet<string>;
  onSubmit: () => void;
}

function LoginFields({
  email,
  setEmail,
  password,
  setPassword,
  missing,
  onSubmit,
}: LoginFieldsProps): React.JSX.Element {
  return (
    <>
      <EmailField
        accessibilityLabel="Email"
        accessibilityHint={missing.has(EMAIL_FIELD) ? REQUIRED_FIELD_HINT : undefined}
        style={styles.inputSpacing}
        value={email}
        onChangeText={setEmail}
      />
      <PasswordField
        accessibilityLabel="Password"
        accessibilityHint={missing.has(PASSWORD_FIELD) ? REQUIRED_FIELD_HINT : undefined}
        style={styles.inputSpacing}
        value={password}
        onChangeText={setPassword}
        returnKeyType="go"
        onSubmitEditing={onSubmit}
      />
    </>
  );
}

interface LoginActionsProps {
  submitting: boolean;
  onLogin: () => void;
  onNavigateSignup: () => void;
  onNavigateForgot: () => void;
}

function LoginActions({
  submitting,
  onLogin,
  onNavigateSignup,
  onNavigateForgot,
}: LoginActionsProps): React.JSX.Element {
  return (
    <>
      <Button
        accessibilityLabel="Log in"
        style={styles.buttonSpacing}
        onPress={onLogin}
        disabled={submitting}
        busy={submitting}
        testID="login-submit"
        label={submitting ? 'Logging in...' : 'Log In'}
      />
      <TouchableOpacity
        accessibilityLabel="Forgot password"
        accessibilityRole="link"
        onPress={onNavigateForgot}
        testID="login-forgot-password"
      >
        <Text style={styles.forgotLink}>Forgot password?</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel="Go to sign-up screen"
        accessibilityRole="link"
        onPress={onNavigateSignup}
      >
        <Text style={styles.link}>
          Don&apos;t have an account? <Text style={styles.linkBold}>Sign Up</Text>
        </Text>
      </TouchableOpacity>
    </>
  );
}

export default function LoginScreen({ navigation }: Props) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Each field is declared as the value that will actually be SENT: the email
  // canonicalized (so "   " is already "" and is refused), the password raw (so
  // an account whose password really is spaces still reaches the server and
  // comes back as the non-enumerating invalid_credentials).
  const required = [
    { label: EMAIL_FIELD, submitted: canonicalizeEmail(email) },
    { label: PASSWORD_FIELD, submitted: password },
  ];
  const { submitting, error, run, missing } = useAuthSubmit(
    // BUG-AUTH-010: trim at submit so paste/autofill whitespace doesn't
    // produce a confusing 422 from the backend.
    // BUG-FE-AUTH-015: lowercase the email client-side so the backend
    // receives the canonical form and a "Foo@bar.com" / "foo@bar.com"
    // login pair can't end up looking like two distinct accounts.
    () => login(canonicalizeEmail(email), password),
    { fallback: LOGIN_FALLBACK, required },
  );

  return (
    <AuthScreenContainer testID="login">
      <AuthBrandBand />
      <Text style={styles.title}>Welcome back</Text>
      <Text style={styles.lead}>Sign in to pick up where you left off.</Text>
      <LoginFields
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        missing={missing}
        onSubmit={run}
      />
      <AuthErrorBanner message={error} testID="login-error" />
      <LoginActions
        submitting={submitting}
        onLogin={run}
        onNavigateSignup={() => navigation.navigate('Signup')}
        onNavigateForgot={() => navigation.navigate('ForgotPassword')}
      />
      {/* Below the primary action on purpose: an offered option, not a push. */}
      <SocialAuthButtons />
    </AuthScreenContainer>
  );
}
