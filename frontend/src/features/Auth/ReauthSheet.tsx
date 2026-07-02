import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { authStyles } from './auth.styles';
import { canonicalizeEmail } from './canonicalizeEmail';
import { EmailField } from './components/EmailField';
import { PasswordField } from './components/PasswordField';

import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  ink,
  surface,
  surfaceShadow,
  type as typeRamp,
} from '@/design/tokens';

const TYPE = typeRamp(0);

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
      <Button
        accessibilityLabel="Sign back in"
        busy={submitting}
        disabled={submitting}
        style={localStyles.submitSpacing}
        onPress={onSubmit}
        testID="reauth-submit"
        label="Sign in"
      />
      <TouchableOpacity
        accessibilityLabel="Sign out"
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting }}
        onPress={onDismiss}
        disabled={submitting}
        testID="reauth-dismiss"
      >
        <Text style={localStyles.secondaryLink}>Sign out instead</Text>
      </TouchableOpacity>
    </>
  );
}

function ReauthForm(props: ReauthFormProps): React.JSX.Element {
  const { email, password, error, submitting } = props;
  const { onEmailChange, onPasswordChange, onSubmit, onDismiss } = props;
  return (
    <View style={localStyles.card}>
      <Text style={localStyles.title}>Sign back in</Text>
      <Text style={localStyles.subtitle}>
        Your session expired. Enter your credentials to keep going where you left off.
      </Text>
      <EmailField
        accessibilityLabel="Email"
        style={authStyles.inputSpacing}
        value={email}
        onChangeText={onEmailChange}
        testID="reauth-email"
      />
      <PasswordField
        accessibilityLabel="Password"
        style={authStyles.inputSpacing}
        value={password}
        onChangeText={onPasswordChange}
        testID="reauth-password"
      />
      {error ? <Text style={authStyles.error}>{error}</Text> : null}
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
      await login(canonicalizeEmail(email), password);
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={localStyles.backdrop}
        testID="reauth-keyboard-avoiding"
      >
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
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Sheet-specific styling (overlay backdrop + compact left-aligned card header);
// the shared input/error come from authStyles and the submit action from the
// warm Button primitive.
const localStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  card: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    ...surfaceShadow.raised,
  },
  title: {
    ...TYPE.title,
    color: ink.primary,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    ...TYPE.body,
    color: ink.soft,
    marginBottom: SPACING.lg,
  },
  submitSpacing: {
    marginBottom: SPACING.md,
  },
  secondaryLink: {
    textAlign: 'center',
    color: ink.soft,
    paddingVertical: SPACING.sm,
  },
});
