import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthScreenContainer } from './AuthScreenContainer';
import { canonicalizeEmail } from './canonicalizeEmail';

import { auth as authApi } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';

const FORGOT_FALLBACK =
  "We couldn't reach the server. Check your connection, then try again in a moment.";

interface Props {
  navigation: { navigate: (_screen: string) => void; goBack: () => void };
}

interface ForgotFieldsProps {
  email: string;
  setEmail: (_v: string) => void;
}

function ForgotFields({ email, setEmail }: ForgotFieldsProps): React.JSX.Element {
  return (
    <TextField
      accessibilityLabel="Email"
      style={styles.inputSpacing}
      placeholder="Email"
      value={email}
      onChangeText={setEmail}
      autoCapitalize="none"
      keyboardType="email-address"
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await authApi.requestPasswordReset({ email: canonicalizeEmail(email) });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(formatApiError(err, { fallback: FORGOT_FALLBACK }));
    } finally {
      setSubmitting(false);
    }
  };

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
      <ForgotFields email={email} setEmail={setEmail} />
      {error && <Text style={styles.error}>{error}</Text>}
      <ForgotActions
        submitting={submitting}
        onSubmit={handleSubmit}
        onBackToLogin={() => navigation.navigate('Login')}
      />
    </AuthScreenContainer>
  );
}
