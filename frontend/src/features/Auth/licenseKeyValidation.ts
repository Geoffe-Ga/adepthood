/**
 * Shortest key Gumroad ever issues — mirrors the backend's floor. This is a
 * length sanity check, not real format validation: only Gumroad knows whether
 * a given key is genuine, so an actual check always happens server-side.
 */
export const MIN_LICENSE_KEY_LENGTH = 8;

/**
 * Ceiling the backend enforces on ``license_key``. Checking it here means an
 * over-length paste is caught before it costs a round trip.
 */
export const MAX_LICENSE_KEY_LENGTH = 128;

/**
 * Copy shared with the ``license_required`` backend code so the field reads the
 * same whether the client or the server noticed the key was missing.
 */
const KEY_REQUIRED = 'Add the license key from your Gumroad receipt to continue.';

/**
 * Validate a Gumroad license key. Returns user-facing copy for the inline field
 * error, or ``null`` when the key is worth sending. Whitespace is trimmed
 * before measuring: a pasted key routinely arrives with padding, and that pad
 * must count against neither the minimum nor the maximum.
 */
export function validateLicenseKey(value: string): string | null {
  const key = value.trim();
  if (key.length === 0) {
    return KEY_REQUIRED;
  }
  if (key.length < MIN_LICENSE_KEY_LENGTH) {
    return `That key looks too short — a Gumroad key is at least ${MIN_LICENSE_KEY_LENGTH} characters.`;
  }
  if (key.length > MAX_LICENSE_KEY_LENGTH) {
    return `That key is longer than ${MAX_LICENSE_KEY_LENGTH} characters. Paste just the key from your receipt.`;
  }
  return null;
}
