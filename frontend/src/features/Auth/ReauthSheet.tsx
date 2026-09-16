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
import { AuthErrorBanner } from './components/AuthErrorBanner';
import { EmailField } from './components/EmailField';
import { PasswordField } from './components/PasswordField';
import { REQUIRED_FIELD_HINT } from './requiredFieldValidation';
import { useAuthSubmit } from './useAuthSubmit';

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

/** Field labels the guard names back to the user. */
const EMAIL_FIELD = 'email';
const PASSWORD_FIELD = 'password'; // pragma: allowlist secret -- a field label, not a credential

// Names no cause, for the same reason as the other auth surfaces: the transport
// layer owns the connectivity diagnosis, and a status the server classified now
// outranks this string.
const REAUTH_FALLBACK = "We couldn't sign you back in. Wait a moment, then try once more.";

interface ReauthFormProps {
  email: string;
  password: string;
  error: string | null;
  submitting: boolean;
  missing: ReadonlySet<string>;
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
  const { email, password, error, submitting, missing } = props;
  const { onEmailChange, onPasswordChange, onSubmit, onDismiss } = props;
  return (
    <View style={localStyles.card}>
      <Text style={localStyles.title}>Sign back in</Text>
      <Text style={localStyles.subtitle}>
        Your session expired. Enter your credentials to keep going where you left off.
      </Text>
      <EmailField
        accessibilityLabel="Email"
        accessibilityHint={missing.has(EMAIL_FIELD) ? REQUIRED_FIELD_HINT : undefined}
        style={authStyles.inputSpacing}
        value={email}
        onChangeText={onEmailChange}
        testID="reauth-email"
      />
      <PasswordField
        accessibilityLabel="Password"
        accessibilityHint={missing.has(PASSWORD_FIELD) ? REQUIRED_FIELD_HINT : undefined}
        style={authStyles.inputSpacing}
        value={password}
        onChangeText={onPasswordChange}
        testID="reauth-password"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
      />
      <AuthErrorBanner message={error} testID="reauth-error" />
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
  // Declared as the values that will be SENT: the email canonicalized, the
  // password raw, so a password that really is whitespace still gets the
  // server's non-enumerating answer rather than this client's guess.
  const required = [
    { label: EMAIL_FIELD, submitted: canonicalizeEmail(email) },
    { label: PASSWORD_FIELD, submitted: password },
  ];
  const { submitting, error, run, missing } = useAuthSubmit(
    () => login(canonicalizeEmail(email), password),
    { fallback: REAUTH_FALLBACK, required },
  );

  const handleDismiss = useCallback(() => {
    if (submitting) {
      return;
    }
    void dismissReauth();
  }, [dismissReauth, submitting]);

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
          missing={missing}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={run}
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
