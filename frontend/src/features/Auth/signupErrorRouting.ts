import { messageForCode } from '@/api/errorMessages';

/**
 * Backend detail codes that belong on the license field itself rather than the
 * form-level banner: each one is something the user fixes by editing that one
 * input. Everything else — an outage, a password problem, a validation
 * rejection — stays in the banner, where it reads as a whole-form condition.
 *
 * Notably absent: ``license_verification_unavailable`` (a Gumroad outage) is
 * not the user's fault and not about their key, so it is deliberately left out
 * of this set and falls through to the banner.
 */
export const LICENSE_FIELD_DETAILS: ReadonlySet<string> = new Set([
  'invalid_license',
  'license_required',
  'too_many_license_attempts',
]);

// ``invalid_license`` alone stands in for four distinct backend outcomes —
// wrong key, wrong product, mismatched email, and an already-registered
// email — deliberately collapsed into one generic code (anti-enumeration).
// The UI must not appear to know which of the four happened, so it renders
// the same inline copy for all of them.

function detailOf(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const detail = (err as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : undefined;
}

/**
 * Copy for the inline license-field error, or ``undefined`` when this failure
 * is not the license field's business — in which case the caller should let the
 * error travel on to the generic banner.
 */
export function licenseFieldMessage(err: unknown): string | undefined {
  const detail = detailOf(err);
  if (detail === undefined || !LICENSE_FIELD_DETAILS.has(detail)) return undefined;
  return messageForCode(detail);
}
