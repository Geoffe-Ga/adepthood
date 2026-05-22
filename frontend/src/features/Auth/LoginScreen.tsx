import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

const LOGIN_FALLBACK =
  "We couldn't sign you in. Check your connection, then try again in a moment.";

// Cap the form width so fields don't stretch edge-to-edge on laptop/desktop
// browsers; on phones the screen is narrower than this so it has no effect.
const FORM_MAX_WIDTH = 480;

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
      <TextInput
        accessibilityLabel="Email"
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextInput
        accessibilityLabel="Password"
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
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
      <TouchableOpacity
        accessibilityLabel="Log in"
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting, busy: submitting }}
        style={styles.button}
        onPress={onLogin}
        disabled={submitting}
        testID="login-submit"
      >
        <Text style={styles.buttonText}>{submitting ? 'Logging in...' : 'Log In'}</Text>
      </TouchableOpacity>
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
      await login(email.trim().toLowerCase(), password);
    } catch (err: unknown) {
      // BUG-FRONTEND-INFRA-016: ``formatApiError`` returns a dedicated
      // timeout message when the new AbortController fires.
      setError(formatApiError(err, { fallback: LOGIN_FALLBACK }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.form}>
        <Text style={styles.title}>Adepthood</Text>
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: colors.background.card,
  },
  form: {
    width: '100%',
    maxWidth: FORM_MAX_WIDTH,
    alignSelf: 'center',
  },
  title: { fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: SPACING.xxl },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    fontSize: 16,
  },
  error: { color: colors.danger, marginBottom: SPACING.md, textAlign: 'center' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md + 2,
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  buttonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  link: { textAlign: 'center', color: colors.text.secondary },
  linkBold: { color: colors.primary, fontWeight: '600' },
  forgotLink: {
    textAlign: 'center',
    color: colors.primary,
    fontWeight: '500',
    marginBottom: SPACING.md,
  },
});
