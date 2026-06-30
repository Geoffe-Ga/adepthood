import React, { useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthBrandBand } from './AuthBrandBand';
import { AuthScreenContainer } from './AuthScreenContainer';
import { canonicalizeEmail } from './canonicalizeEmail';
import { EmailField } from './components/EmailField';
import { PasswordField } from './components/PasswordField';

import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';

const LOGIN_FALLBACK =
  "We couldn't sign you in. Check your connection, then try again in a moment.";

interface Props {
  navigation: { navigate: (_screen: string) => void };
}

interface LoginFieldsProps {
  email: string;
  setEmail: (_v: string) => void;
  password: string;
  setPassword: (_v: string) => void;
}

function LoginFields({
  email,
  setEmail,
  password,
  setPassword,
}: LoginFieldsProps): React.JSX.Element {
  return (
    <>
      <EmailField
        accessibilityLabel="Email"
        style={styles.inputSpacing}
        value={email}
        onChangeText={setEmail}
      />
      <PasswordField
        accessibilityLabel="Password"
        style={styles.inputSpacing}
        value={password}
        onChangeText={setPassword}
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      // BUG-AUTH-010: trim at submit so paste/autofill whitespace doesn't
      // produce a confusing 422 from the backend.
      // BUG-FE-AUTH-015: lowercase the email client-side so the backend
      // receives the canonical form and a "Foo@bar.com" / "foo@bar.com"
      // login pair can't end up looking like two distinct accounts.
      await login(canonicalizeEmail(email), password);
    } catch (err: unknown) {
      // BUG-FRONTEND-INFRA-016: ``formatApiError`` returns a dedicated
      // timeout message when the new AbortController fires.
      setError(formatApiError(err, { fallback: LOGIN_FALLBACK }));
    } finally {
      setSubmitting(false);
    }
  };

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
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <LoginActions
        submitting={submitting}
        onLogin={handleLogin}
        onNavigateSignup={() => navigation.navigate('Signup')}
        onNavigateForgot={() => navigation.navigate('ForgotPassword')}
      />
    </AuthScreenContainer>
  );
}
