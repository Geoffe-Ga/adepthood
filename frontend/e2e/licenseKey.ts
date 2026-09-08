import { randomUUID } from 'node:crypto';

/**
 * A licence key no other signup in the lane has presented.
 *
 * The launcher's Gumroad stub reports the key itself as the sale id, so two
 * signups presenting one key are two claims on one sale — and one sale binds
 * to exactly one active account (ADR 0008). Every account a journey creates
 * therefore needs its own key, and a journey that wants to prove the invariant
 * reuses one on purpose.
 */
export function freshLicenseKey(): string {
  return `e2e-license-${randomUUID()}`;
}
