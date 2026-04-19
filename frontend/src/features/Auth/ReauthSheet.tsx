import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

const REAUTH_FALLBACK =
  "We couldn't sign you back in. Check your connection, then try again in a moment.";

interface ReauthFormProps {
  email: string;
  password: string;
  error: string | null;
  submitting: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}

function ReauthActions({
  submitting,
  onSubmit,
  onDismiss,
}: {
  submitting: boolean;
  onSubmit: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <>
      <TouchableOpacity
        accessibilityLabel="Sign back in"
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting, busy: submitting }}
        style={styles.primaryButton}
        onPress={onSubmit}
        disabled={submitting}
        testID="reauth-submit"
      >
        {submitting ? (
          <ActivityIndicator color={colors.text.light} />
        ) : (
          <Text style={styles.primaryButtonText}>Sign in</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel="Sign out"
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting }}
        onPress={onDismiss}
        disabled={submitting}
        testID="reauth-dismiss"
      >
        <Text style={styles.secondaryLink}>Sign out instead</Text>
      </TouchableOpacity>
    </>
  );
}

function ReauthForm(props: ReauthFormProps): React.JSX.Element {
  const { email, password, error, submitting } = props;
  const { onEmailChange, onPasswordChange, onSubmit, onDismiss } = props;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Sign back in</Text>
      <Text style={styles.subtitle}>
        Your session expired. Enter your credentials to keep going where you left off.
      </Text>
      <TextInput
        accessibilityLabel="Email"
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={onEmailChange}
        autoCapitalize="none"
        keyboardType="email-address"
        testID="reauth-email"
      />
      <TextInput
        accessibilityLabel="Password"
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={onPasswordChange}
        secureTextEntry
        testID="reauth-password"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ReauthActions submitting={submitting} onSubmit={onSubmit} onDismiss={onDismiss} />
    </View>
  );
}

/**
 * BUG-NAV-001: the re-auth sheet is an overlay — it sits *on top of*
 * RootStack so a 401-induced ``'reauth-required'`` transition never
 * unmounts BottomTabs. The user re-authenticates in place and lands
 * back on the tab they were on.
 */
export function ReauthSheet(): React.JSX.Element {
  const { login, dismissReauth } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err: unknown) {
      setError(formatApiError(err, { fallback: REAUTH_FALLBACK }));
    } finally {
      setSubmitting(false);
    }
  }, [login, email, password]);

  const handleDismiss = useCallback(() => {
    void dismissReauth();
  }, [dismissReauth]);

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={handleDismiss}
      testID="reauth-sheet"
    >
      <View style={styles.backdrop}>
        <ReauthForm
          email={email}
          password={password}
          error={error}
          submitting={submitting}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={handleSubmit}
          onDismiss={handleDismiss}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  card: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    marginBottom: SPACING.lg,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    fontSize: 16,
  },
  error: {
    color: colors.danger,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md + 2,
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  primaryButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  secondaryLink: {
    textAlign: 'center',
    color: colors.text.secondary,
    paddingVertical: SPACING.sm,
  },
});
