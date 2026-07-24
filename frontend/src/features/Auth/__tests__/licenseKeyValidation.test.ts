/* eslint-env jest */
/* global describe, it, expect */
import {
  MAX_LICENSE_KEY_LENGTH,
  MIN_LICENSE_KEY_LENGTH,
  validateLicenseKey,
} from '../licenseKeyValidation';

// A realistic Gumroad key: four dash-separated uppercase-hex groups, 35 chars.
const REALISTIC_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret

describe('license key length bounds', () => {
  it('mirrors the backend contract of 8..128 characters', () => {
    expect(MIN_LICENSE_KEY_LENGTH).toBe(8);
    expect(MAX_LICENSE_KEY_LENGTH).toBe(128);
  });
});

describe('validateLicenseKey', () => {
  it.each([[''], ['   '], ['\t\n ']])('asks for the key when the field is %p', (value) => {
    expect(validateLicenseKey(value)).toBe(
      'Add the license key from your Gumroad receipt to continue.',
    );
  });

  it('rejects a key one character below the minimum', () => {
    const message = validateLicenseKey('A1B2C3D'); // pragma: allowlist secret

    expect(message).toMatch(/at least 8/);
  });

  it('accepts a key exactly at the minimum length', () => {
    expect(validateLicenseKey('A1B2C3D4')).toBeNull(); // pragma: allowlist secret
  });

  it('accepts a key exactly at the maximum length', () => {
    expect(validateLicenseKey('K'.repeat(MAX_LICENSE_KEY_LENGTH))).toBeNull();
  });

  it('rejects a key one character above the maximum', () => {
    const message = validateLicenseKey('K'.repeat(MAX_LICENSE_KEY_LENGTH + 1));

    expect(message).toMatch(/128/);
  });

  it('accepts a realistic dashed uppercase-hex Gumroad key', () => {
    expect(validateLicenseKey(REALISTIC_KEY)).toBeNull();
  });

  it('trims surrounding whitespace before measuring the length', () => {
    // 8 significant characters padded either side: the pad must not count
    // toward the minimum, and the value must not be rejected as too long.
    expect(validateLicenseKey('   A1B2C3D4   ')).toBeNull(); // pragma: allowlist secret
    expect(validateLicenseKey('  A1B2C3D  ')).toMatch(/at least 8/); // pragma: allowlist secret
  });

  it('counts only the trimmed key against the maximum', () => {
    const padded = `  ${'K'.repeat(MAX_LICENSE_KEY_LENGTH)}  `;

    expect(validateLicenseKey(padded)).toBeNull();
  });

  it('never returns snake_case backend vocabulary to the user', () => {
    const messages = [validateLicenseKey(''), validateLicenseKey('A1B2C3D')].filter(
      (message): message is string => message !== null,
    );

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toMatch(/[a-z]_[a-z]/);
      expect(message).toMatch(/[.!?]$/);
    }
  });
});
