/**
 * Canonicalize an email for submission: trim surrounding whitespace and
 * lowercase. Login already did this; signup/reauth did not, so a user who
 * signed up as ``Foo@Bar.com`` and logged in as ``foo@bar.com`` looked like two
 * accounts client-side (audit-ux-08). One helper keeps every auth path aligned.
 */
export const canonicalizeEmail = (raw: string): string => raw.trim().toLowerCase();
