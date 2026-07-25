import { useCallback, useState } from 'react';

import { canonicalizeEmail } from './canonicalizeEmail';
import { validateLicenseKey } from './licenseKeyValidation';
import { validatePasswordPair } from './passwordValidation';
import { licenseFieldMessage } from './signupErrorRouting';
import { useAuthSubmit } from './useAuthSubmit';

import { useAuth } from '@/context/AuthContext';

const SIGNUP_FALLBACK =
  "We couldn't create your account. Check your connection, then try again in a moment.";

/** Everything the signup form renders and drives. */
export interface SignupForm {
  email: string;
  setEmail: (_v: string) => void;
  password: string;
  setPassword: (_v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (_v: string) => void;
  licenseKey: string;
  setLicenseKey: (_v: string) => void;
  /** Field-scoped license error; the form-level banner stays clear. */
  licenseError: string | null;
  /** Form-level banner copy. */
  error: string | null;
  submitting: boolean;
  handleSignup: () => void;
}

/**
 * State, validation and error routing for the signup form.
 *
 * Errors land in one of two places. Anything the user fixes by editing the
 * license key is caught here and shown inline on that field; everything else is
 * re-thrown so {@link useAuthSubmit} renders it in the form-level banner
 * exactly as it does for every other auth screen.
 *
 * The license key is handled as a credential, not a form value: it is trimmed
 * only at submit (never on every keystroke, which would fight a mid-paste
 * selection) and it is never persisted or logged — it lives in component
 * state for the lifetime of this screen and nowhere else.
 *
 * ``initialLicenseKey`` seeds the field from a route param, which is the seam a
 * later post-purchase deep link (or social-auth flow) reuses.
 */
export function useSignupForm(initialLicenseKey = ''): SignupForm {
  const { signup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [licenseKey, setKey] = useState(initialLicenseKey);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  const { submitting, error, setError, run } = useAuthSubmit(
    async () => {
      setLicenseError(null);
      try {
        // BUG-AUTH-010 / audit-ux-08: canonicalize the email and trim the key at
        // submit so paste and autofill whitespace never reaches the backend.
        await signup(canonicalizeEmail(email), password, licenseKey.trim());
      } catch (err: unknown) {
        const inline = licenseFieldMessage(err);
        if (inline === undefined) throw err;
        setLicenseError(inline);
      }
    },
    { fallback: SIGNUP_FALLBACK },
  );

  // Editing the key retracts the verdict on it — a stale "we couldn't verify
  // that key" under a key the user has since corrected reads as a broken form.
  const setLicenseKey = useCallback((value: string): void => {
    setKey(value);
    setLicenseError(null);
  }, []);

  const handleSignup = (): void => {
    const passwordError = validatePasswordPair(password, confirmPassword);
    const keyError = validateLicenseKey(licenseKey);
    setError(passwordError);
    setLicenseError(keyError);
    if (passwordError !== null || keyError !== null) return;
    void run();
  };

  return {
    email,
    setEmail,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    licenseKey,
    setLicenseKey,
    licenseError,
    error,
    submitting,
    handleSignup,
  };
}
