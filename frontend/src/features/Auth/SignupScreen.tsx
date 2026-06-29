import React, { useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthScreenContainer } from './AuthScreenContainer';
import { canonicalizeEmail } from './canonicalizeEmail';
import { validatePasswordPair } from './passwordValidation';

import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';

const SIGNUP_FALLBACK =
  "We couldn't create your account. Check your connection, then try again in a moment.";

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
      <TextField
        accessibilityLabel="Email"
        style={styles.inputSpacing}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextField
        accessibilityLabel="Password"
        style={styles.inputSpacing}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <TextField
        accessibilityLabel="Confirm password"
        style={styles.inputSpacing}
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
      <Button
        accessibilityLabel="Create account"
        style={styles.buttonSpacing}
        onPress={onSignup}
        disabled={submitting}
        busy={submitting}
        testID="signup-submit"
        label={submitting ? 'Creating account...' : 'Sign Up'}
      />
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

    const validationError = validatePasswordPair(password, confirmPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      // BUG-AUTH-010: trim at submit so paste/autofill whitespace doesn't
      // produce a confusing 422 from the backend.
      await signup(canonicalizeEmail(email), password);
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
    <AuthScreenContainer testID="signup">
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
    </AuthScreenContainer>
  );
}
