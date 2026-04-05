import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { useAuth } from '@/context/AuthContext';

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
      <TextInput
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <TextInput
        style={styles.input}
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
      <TouchableOpacity style={styles.button} onPress={onSignup} disabled={submitting}>
        <Text style={styles.buttonText}>{submitting ? 'Creating account...' : 'Sign Up'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onNavigateLogin}>
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

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      await signup(email, password);
    } catch (err: unknown) {
      const detail =
        (err as { detail?: string }).detail ?? (err as Error).message ?? 'Signup failed';
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: 32 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  error: { color: '#d32f2f', marginBottom: 12, textAlign: 'center' },
  button: {
    backgroundColor: '#4a90d9',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { textAlign: 'center', color: '#666' },
  linkBold: { color: '#4a90d9', fontWeight: '600' },
});
