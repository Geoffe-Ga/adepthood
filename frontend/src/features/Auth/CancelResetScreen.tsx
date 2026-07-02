import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthScreenContainer } from './AuthScreenContainer';
import { MIN_TOKEN_LENGTH } from './resetToken';

import { auth as authApi } from '@/api';
import { Button } from '@/components/Button';
import { SPACING, ink, type as typeRamp } from '@/design/tokens';

const TYPE = typeRamp(0);

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
    <AuthScreenContainer testID="cancel-reset">
      <Text style={localStyles.title}>{title}</Text>
      <Text style={styles.subtitle}>{body}</Text>
      <Button
        accessibilityLabel="Back to log in"
        variant="secondary"
        style={styles.buttonSpacing}
        onPress={onBackToLogin}
        testID="cancel-reset-back-to-login"
        label="Back to Log In"
      />
    </AuthScreenContainer>
  );
}

function PendingView(): React.JSX.Element {
  return (
    <AuthScreenContainer testID="cancel-reset">
      <ActivityIndicator size="large" testID="cancel-reset-pending" />
      <Text style={styles.subtitle}>Cancelling that reset request...</Text>
    </AuthScreenContainer>
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

// Confirmation-screen title (smaller marginBottom than the shared form title);
// the container/subtitle/button come from the shared authStyles.
const localStyles = StyleSheet.create({
  title: { ...TYPE.title, color: ink.primary, textAlign: 'center', marginBottom: SPACING.md },
});
