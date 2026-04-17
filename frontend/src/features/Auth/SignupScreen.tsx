import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

const SIGNUP_FALLBACK =
  "We couldn't create your account. Check your connection, then try again in a moment.";
const MIN_PASSWORD_LENGTH = 8;

interface Props {
  navigation: { navigate: (_screen: string) => void };
}

interface SignupFieldsProps {
  email: string;
  setEmail: (_v: string) => void;
  password: string;
  setPassword: (_v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (_v: string) => void;
}

function SignupFields({
  email,
  setEmail,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
}: SignupFieldsProps) {
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
      <TextInput
        accessibilityLabel="Confirm password"
        style={styles.input}
        placeholder="Confirm Password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secureTextEntry
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
      <TouchableOpacity
        accessibilityLabel="Create account"
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting, busy: submitting }}
        style={styles.button}
        onPress={onSignup}
        disabled={submitting}
        testID="signup-submit"
      >
        <Text style={styles.buttonText}>{submitting ? 'Creating account...' : 'Sign Up'}</Text>
      </TouchableOpacity>
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

export default function SignupScreen({ navigation }: Props) {
  const { signup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSignup = async () => {
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Pick a password that is at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Those passwords don't match. Re-type both fields to confirm.");
      return;
    }

    setSubmitting(true);
    try {
      // BUG-AUTH-010: trim at submit so paste/autofill whitespace doesn't
      // produce a confusing 422 from the backend.
      await signup(email.trim(), password);
    } catch (err: unknown) {
      // BUG-FRONTEND-INFRA-016 — timeout-specific message handled via
      // formatApiError; backend detail codes mapped through the shared
      // mapper instead of leaking snake_case to the user.
      setError(formatApiError(err, { fallback: SIGNUP_FALLBACK }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Create Account</Text>
      <SignupFields
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <SignupActions
        onSignup={handleSignup}
        onNavigateLogin={() => navigation.navigate('Login')}
        submitting={submitting}
      />
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
});
