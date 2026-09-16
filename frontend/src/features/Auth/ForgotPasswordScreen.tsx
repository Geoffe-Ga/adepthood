import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthScreenContainer } from './AuthScreenContainer';
import { canonicalizeEmail } from './canonicalizeEmail';
import { AuthErrorBanner } from './components/AuthErrorBanner';
import { EmailField } from './components/EmailField';
import { REQUIRED_FIELD_HINT } from './requiredFieldValidation';
import { useAuthSubmit } from './useAuthSubmit';

import { auth as authApi } from '@/api';
import { Button } from '@/components/Button';

/** The one field this screen refuses to send empty. */
const EMAIL_FIELD = 'email';

// Names no cause: a blank field, a 422 and a 500 all used to arrive here wearing
// "check your connection" on a healthy network. The transport layer diagnoses a
// real outage from its own evidence; this string covers only what nothing else
// could classify.
const FORGOT_FALLBACK = "We couldn't send that reset link. Give it a moment, then try again.";

interface Props {
  navigation: { navigate: (_screen: string) => void };
}

interface ForgotFieldsProps {
  email: string;
  setEmail: (_v: string) => void;
  missing: ReadonlySet<string>;
  onSubmit: () => void;
}

function ForgotFields({
  email,
  setEmail,
  missing,
  onSubmit,
}: ForgotFieldsProps): React.JSX.Element {
  return (
    <EmailField
      accessibilityLabel="Email"
      accessibilityHint={missing.has(EMAIL_FIELD) ? REQUIRED_FIELD_HINT : undefined}
      style={styles.inputSpacing}
      value={email}
      onChangeText={setEmail}
      returnKeyType="go"
      onSubmitEditing={onSubmit}
    />
  );
}

interface ForgotActionsProps {
  submitting: boolean;
  onSubmit: () => void;
  onBackToLogin: () => void;
}

function ForgotActions({
  submitting,
  onSubmit,
  onBackToLogin,
}: ForgotActionsProps): React.JSX.Element {
  return (
    <>
      <Button
        accessibilityLabel="Send reset link"
        style={styles.buttonSpacing}
        onPress={onSubmit}
        disabled={submitting}
        busy={submitting}
        testID="forgot-submit"
        label={submitting ? 'Sending...' : 'Send Reset Link'}
      />
      <TouchableOpacity
        accessibilityLabel="Back to log in"
        accessibilityRole="link"
        onPress={onBackToLogin}
      >
        <Text style={styles.link}>
          Remembered it? <Text style={styles.linkBold}>Log In</Text>
        </Text>
      </TouchableOpacity>
    </>
  );
}

/**
 * The success state intentionally does NOT distinguish between
 * "registered" and "unregistered" emails -- the backend returns the
 * same 202 + body shape for both (SPEC R4 anti-enumeration), and
 * surfacing different copy here would defeat the property end-to-end.
 */
function SuccessNotice({ onBackToLogin }: { onBackToLogin: () => void }): React.JSX.Element {
  return (
    <View>
      <Text style={styles.successTitle}>Check your inbox</Text>
      <Text style={styles.successBody}>
        If we have an account for that address, a reset link is on its way. The link expires in 30
        minutes.
      </Text>
      <Button
        accessibilityLabel="Back to log in"
        variant="secondary"
        style={styles.buttonSpacing}
        onPress={onBackToLogin}
        testID="forgot-back-to-login"
        label="Back to Log In"
      />
    </View>
  );
}

export default function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  // ``/auth/password-reset/request`` is limited to three per hour, counted by
  // the middleware BEFORE FastAPI parses the body -- so three blank taps used to
  // spend the user's whole recovery budget on requests the server was always
  // going to refuse. The guard is what keeps those three for real attempts.
  const { submitting, error, run, missing } = useAuthSubmit(
    async () => {
      await authApi.requestPasswordReset({ email: canonicalizeEmail(email) });
      setSubmitted(true);
    },
    {
      fallback: FORGOT_FALLBACK,
      required: [{ label: EMAIL_FIELD, submitted: canonicalizeEmail(email) }],
    },
  );

  if (submitted) {
    return (
      <AuthScreenContainer testID="forgot-password">
        <Text style={styles.title}>Forgot Password</Text>
        <SuccessNotice onBackToLogin={() => navigation.navigate('Login')} />
      </AuthScreenContainer>
    );
  }

  return (
    <AuthScreenContainer testID="forgot-password">
      <Text style={styles.title}>Forgot Password</Text>
      <Text style={styles.subtitle}>
        Enter your account email and we&apos;ll send a link to set a new password.
      </Text>
      <ForgotFields email={email} setEmail={setEmail} missing={missing} onSubmit={run} />
      <AuthErrorBanner message={error} testID="forgot-error" />
      <ForgotActions
        submitting={submitting}
        onSubmit={run}
        onBackToLogin={() => navigation.navigate('Login')}
      />
    </AuthScreenContainer>
  );
}
