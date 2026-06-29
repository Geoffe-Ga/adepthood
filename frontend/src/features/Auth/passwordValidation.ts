/** Minimum password length enforced on signup and password reset. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate a password + confirmation pair. Returns a user-facing error string,
 * or ``null`` when the pair is acceptable. Shared by the signup and
 * reset-password screens so the rules and copy stay identical.
 */
export function validatePasswordPair(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Pick a password that is at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password !== confirmPassword) {
    return "Those passwords don't match. Re-type both fields to confirm.";
  }
  return null;
}
