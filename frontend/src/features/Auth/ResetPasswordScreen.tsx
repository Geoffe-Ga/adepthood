import React, { useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthScreenContainer } from './AuthScreenContainer';
import { PasswordField } from './components/PasswordField';
import { validatePasswordPair } from './passwordValidation';
import { MIN_TOKEN_LENGTH } from './resetToken';

import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';

const RESET_FALLBACK =
  "We couldn't apply that reset. The link may have expired -- request a new one and try again.";

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
      <PasswordField
        accessibilityLabel="New password"
        style={styles.inputSpacing}
        placeholder="New Password"
        value={password}
        onChangeText={setPassword}
        textContentType="newPassword"
      />
      <PasswordField
        accessibilityLabel="Confirm new password"
        style={styles.inputSpacing}
        placeholder="Confirm New Password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
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
      <Button
        accessibilityLabel="Set new password"
        style={styles.buttonSpacing}
        onPress={onSubmit}
        disabled={submitting}
        busy={submitting}
        testID="reset-submit"
        label={submitting ? 'Setting password...' : 'Set Password'}
      />
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
    <AuthScreenContainer testID="reset-password">
      <Text style={styles.title}>Reset Link Invalid</Text>
      <Text style={styles.subtitle}>
        That link is missing or malformed. Request a fresh one to continue.
      </Text>
      <Button
        accessibilityLabel="Request a new reset link"
        variant="secondary"
        style={styles.buttonSpacing}
        onPress={onRequestNew}
        testID="reset-request-new"
        label="Request New Link"
      />
    </AuthScreenContainer>
  );
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
    const validationError = validatePasswordPair(password, confirmPassword);
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
    <AuthScreenContainer testID="reset-password">
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
    </AuthScreenContainer>
  );
}
