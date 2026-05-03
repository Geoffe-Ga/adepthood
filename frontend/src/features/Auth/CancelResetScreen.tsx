import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { auth as authApi } from '@/api';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

const MIN_TOKEN_LENGTH = 32;

type CancelStatus = 'pending' | 'success' | 'error' | 'invalid_token';

interface RouteParams {
  token?: string;
}

interface Props {
  navigation: { navigate: (_screen: string) => void };
  route?: { params?: RouteParams };
}

interface TerminalViewProps {
  title: string;
  body: string;
  onBackToLogin: () => void;
}

function TerminalView({ title, body, onBackToLogin }: TerminalViewProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{body}</Text>
      <TouchableOpacity
        accessibilityLabel="Back to log in"
        accessibilityRole="button"
        style={styles.button}
        onPress={onBackToLogin}
        testID="cancel-reset-back-to-login"
      >
        <Text style={styles.buttonText}>Back to Log In</Text>
      </TouchableOpacity>
    </View>
  );
}

function PendingView(): React.JSX.Element {
  return (
    <View style={styles.container} testID="cancel-reset-pending">
      <ActivityIndicator size="large" />
      <Text style={styles.subtitle}>Cancelling that reset request...</Text>
    </View>
  );
}

const STATUS_COPY: Record<Exclude<CancelStatus, 'pending'>, { title: string; body: string }> = {
  invalid_token: {
    title: 'Cancel Link Invalid',
    body:
      'That cancel link is missing or malformed. If you did not request a reset, you can ignore ' +
      'the original email -- nothing happens until the link is clicked.',
  },
  error: {
    title: 'Could Not Reach Server',
    body:
      'We could not confirm the cancellation. Check your connection and tap the link again, or ' +
      'ignore the original email -- the link expires in 30 minutes either way.',
  },
  success: {
    title: 'Reset Cancelled',
    body:
      'The reset link has been invalidated. Your password has not changed. If you did not request ' +
      'a reset, no further action is needed.',
  },
};

/**
 * Landing screen for the "this wasn't me" link in the reset email
 * (``adepthood://cancel-reset?token=...``).  Possession of the token
 * is the only auth -- mirrors the backend's trust model -- so we hit
 * ``/auth/password-reset/cancel`` immediately on mount and surface
 * the outcome.  The endpoint returns 204 on both hit and miss
 * (anti-enumeration), so the UI shows the same confirmation either
 * way; an error here means the request itself failed (network etc.).
 */
export default function CancelResetScreen({ navigation, route }: Props) {
  const token = route?.params?.token ?? '';
  const tokenLooksValid = token.length >= MIN_TOKEN_LENGTH;
  const [status, setStatus] = useState<CancelStatus>(tokenLooksValid ? 'pending' : 'invalid_token');

  useEffect(() => {
    if (!tokenLooksValid) return;
    authApi
      .cancelPasswordReset({ token })
      .then(() => setStatus('success'))
      .catch(() => setStatus('error'));
  }, [token, tokenLooksValid]);

  const onBackToLogin = () => navigation.navigate('Login');

  if (status === 'pending') return <PendingView />;
  const copy = STATUS_COPY[status];
  return <TerminalView title={copy.title} body={copy.body} onBackToLogin={onBackToLogin} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: colors.background.card,
  },
  title: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: SPACING.md },
  subtitle: {
    fontSize: 15,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.buttonV,
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  buttonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
});
