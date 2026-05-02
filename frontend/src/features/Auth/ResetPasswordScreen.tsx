import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

const RESET_FALLBACK =
  "We couldn't apply that reset. The link may have expired -- request a new one and try again.";
const MIN_PASSWORD_LENGTH = 8;
const MIN_TOKEN_LENGTH = 32;

interface RouteParams {
  token?: string;
}

interface Props {
  navigation: { navigate: (_screen: string) => void };
  route?: { params?: RouteParams };
}

interface ResetFieldsProps {
  password: string;
  setPassword: (_v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (_v: string) => void;
}

function ResetFields({
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
}: ResetFieldsProps): React.JSX.Element {
  return (
    <>
      <TextInput
        accessibilityLabel="New password"
        style={styles.input}
        placeholder="New Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
      />
      <TextInput
        accessibilityLabel="Confirm new password"
        style={styles.input}
        placeholder="Confirm New Password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secureTextEntry
        textContentType="newPassword"
      />
    </>
  );
}

interface ResetActionsProps {
  submitting: boolean;
  onSubmit: () => void;
  onBackToLogin: () => void;
}

function ResetActions({
  submitting,
  onSubmit,
  onBackToLogin,
}: ResetActionsProps): React.JSX.Element {
  return (
    <>
      <TouchableOpacity
        accessibilityLabel="Set new password"
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting, busy: submitting }}
        style={styles.button}
        onPress={onSubmit}
        disabled={submitting}
        testID="reset-submit"
      >
        <Text style={styles.buttonText}>{submitting ? 'Setting password...' : 'Set Password'}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel="Back to log in"
        accessibilityRole="link"
        onPress={onBackToLogin}
      >
        <Text style={styles.link}>
          Changed your mind? <Text style={styles.linkBold}>Log In</Text>
        </Text>
      </TouchableOpacity>
    </>
  );
}

function MissingTokenView({ onRequestNew }: { onRequestNew: () => void }): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Reset Link Invalid</Text>
      <Text style={styles.subtitle}>
        That link is missing or malformed. Request a fresh one to continue.
      </Text>
      <TouchableOpacity
        accessibilityLabel="Request a new reset link"
        accessibilityRole="button"
        style={styles.button}
        onPress={onRequestNew}
        testID="reset-request-new"
      >
        <Text style={styles.buttonText}>Request New Link</Text>
      </TouchableOpacity>
    </View>
  );
}

function _validatePasswordPair(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Pick a password that is at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password !== confirmPassword) {
    return "Those passwords don't match. Re-type both fields to confirm.";
  }
  return null;
}

export default function ResetPasswordScreen({ navigation, route }: Props) {
  const { confirmPasswordReset } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const token = route?.params?.token ?? '';

  if (!token || token.length < MIN_TOKEN_LENGTH) {
    return <MissingTokenView onRequestNew={() => navigation.navigate('ForgotPassword')} />;
  }

  const handleSubmit = async () => {
    setError(null);
    const validationError = _validatePasswordPair(password, confirmPassword);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      // applyAuthResponse inside the context flips authStatus to
      // ``authenticated``, which the App-level navigator picks up to
      // swap the AuthStack for RootStack.  No explicit navigation
      // call is needed here.
    } catch (err: unknown) {
      setError(formatApiError(err, { fallback: RESET_FALLBACK }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Set New Password</Text>
      <Text style={styles.subtitle}>Pick a new password (at least 8 characters).</Text>
      <ResetFields
        password={password}
        setPassword={setPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <ResetActions
        submitting={submitting}
        onSubmit={handleSubmit}
        onBackToLogin={() => navigation.navigate('Login')}
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
  title: { fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: SPACING.lg },
  subtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
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
