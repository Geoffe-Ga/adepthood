/**
 * The one required-field rule the Auth screens share.
 *
 * Sending a blank credential is not a neutral round trip. Every auth route sits
 * behind a rate limiter that counts the request before FastAPI has parsed the
 * body -- ``/auth/password-reset/request`` allows three per hour -- so three
 * blank taps on Send Reset Link spend the user's entire recovery budget and
 * lock them out of password recovery for an hour, while the screen blames their
 * connection for a 422 the server was right to send. Refusing an empty field
 * before the network call is what keeps that budget for the attempt the user
 * actually meant.
 *
 * Sibling to {@link ./passwordValidation} and {@link ./licenseKeyValidation}:
 * one predicate, one wording, one place to change either.
 */

/** A field a submit path refuses to send without. */
export interface RequiredField {
  /** Name used in the message: "Enter your email and password to continue." */
  readonly label: string;
  /**
   * The value **exactly as it will be sent** -- ``canonicalizeEmail(email)`` for
   * an address, the raw string for a password.
   *
   * There is deliberately no trim rule of this module's own. An account whose
   * password is eight spaces is creatable and loggable-in today (``AuthRequest``
   * measures ``min_length`` without stripping), so a guard that trimmed would
   * lock that user out of this client permanently while telling them to enter
   * the password they are holding. Measuring the submitted value keeps the
   * client's verdict and the server's verdict about the same string.
   */
  readonly submitted: string;
}

/**
 * Hint spoken after the field's own accessible name, so a screen-reader user
 * who swipes from the banner to the control learns why it was flagged.
 */
export const REQUIRED_FIELD_HINT = 'Required.';

/** Labels of the fields that would be sent empty, in declaration order. */
export function missingRequiredFields(fields: readonly RequiredField[]): readonly string[] {
  return fields.filter((field) => field.submitted.length === 0).map((field) => field.label);
}

/**
 * Copy naming which fields are missing, or ``null`` when nothing is.
 *
 * Naming them is the point: "fill in the form" leaves the user to find what the
 * client already knows.
 */
export function requiredFieldMessage(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  return `Enter your ${labels.join(' and ')} to continue.`;
}
