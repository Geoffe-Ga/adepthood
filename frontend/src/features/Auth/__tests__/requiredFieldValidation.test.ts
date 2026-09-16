/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  missingRequiredFields,
  requiredFieldMessage,
  REQUIRED_FIELD_HINT,
} from '../requiredFieldValidation';

const EMAIL = 'email';
const PASSWORD = 'password'; // pragma: allowlist secret -- a field label, not a credential

describe('missingRequiredFields', () => {
  it('returns no missing fields when every value is present', () => {
    expect(
      missingRequiredFields([
        { label: EMAIL, submitted: 'user@test.com' },
        { label: PASSWORD, submitted: 'password123' }, // pragma: allowlist secret
      ]),
    ).toEqual([]);
  });

  it('reports the email when only the email is blank', () => {
    expect(
      missingRequiredFields([
        { label: EMAIL, submitted: '' },
        { label: PASSWORD, submitted: 'password123' }, // pragma: allowlist secret
      ]),
    ).toEqual([EMAIL]);
  });

  it('reports the password when only the password is blank', () => {
    expect(
      missingRequiredFields([
        { label: EMAIL, submitted: 'user@test.com' },
        { label: PASSWORD, submitted: '' },
      ]),
    ).toEqual([PASSWORD]);
  });

  it('reports both when both are blank', () => {
    expect(
      missingRequiredFields([
        { label: EMAIL, submitted: '' },
        { label: PASSWORD, submitted: '' },
      ]),
    ).toEqual([EMAIL, PASSWORD]);
  });

  // The predicate measures the value exactly as it will be sent. A caller that
  // canonicalizes an email hands over ``''``; a caller sending a password raw
  // hands over the spaces, and the server -- not this client -- decides.
  it('measures the submitted value rather than a trimmed copy', () => {
    expect(missingRequiredFields([{ label: PASSWORD, submitted: '        ' }])).toEqual([]);
    expect(missingRequiredFields([{ label: EMAIL, submitted: '' }])).toEqual([EMAIL]);
  });

  it('treats an empty declaration as nothing to check', () => {
    expect(missingRequiredFields([])).toEqual([]);
  });
});

describe('requiredFieldMessage', () => {
  it('names the missing fields in the message', () => {
    expect(requiredFieldMessage([EMAIL, PASSWORD])).toBe(
      'Enter your email and password to continue.',
    );
  });

  it('names a single missing field on its own', () => {
    expect(requiredFieldMessage([EMAIL])).toBe('Enter your email to continue.');
  });

  it('returns null when nothing is missing', () => {
    expect(requiredFieldMessage([])).toBeNull();
  });
});

describe('REQUIRED_FIELD_HINT', () => {
  it('is short enough to be read after the field label', () => {
    expect(REQUIRED_FIELD_HINT).toBe('Required.');
  });
});
