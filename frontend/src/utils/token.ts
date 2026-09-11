import { toByteArray } from 'base64-js';

/** Seconds before expiration at which we proactively refresh the token. */
export const REFRESH_BUFFER_SECONDS = 5 * 60;

/**
 * Fraction of a token's lifetime after which any open app renews it (#2804).
 *
 * The server mints 30-day tokens. Renewing only inside the five-minute
 * buffer would log a daily user out on day 30 whatever they did; renewing
 * past the half-life mark makes the session slide, so only a month of not
 * opening the app at all ends it. Half is the balance between how often the
 * old token is rotated away (each renewal writes a revocation row) and how
 * long a user can stay away before being asked to sign in again.
 */
export const SLIDING_RENEWAL_FRACTION = 0.5;

const MS_PER_SECOND = 1000;

export interface JwtPayload {
  sub: string;
  exp: number;
  /** Issued-at. Optional because only ``exp`` is validated on decode. */
  iat?: number;
}

/**
 * Decode a JWT payload without verifying the signature.
 *
 * Client-side decoding is safe here because the server validates the
 * signature on every request. We only need the `exp` claim to schedule
 * proactive refresh.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // JWT base64url → standard base64
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = toByteArray(padded);
    const json = new TextDecoder().decode(bytes);
    const payload = JSON.parse(json) as JwtPayload;
    if (typeof payload.exp !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Check whether a token has already expired.
 * Returns true if the token is expired or unparseable.
 */
export function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  return payload.exp * 1000 <= Date.now();
}

/**
 * The instant (epoch ms) at which a token becomes due for proactive refresh.
 *
 * The earlier of two marks: ``REFRESH_BUFFER_SECONDS`` before ``exp`` (the
 * floor that keeps a short token from lapsing mid-request) and the
 * ``SLIDING_RENEWAL_FRACTION`` point of the ``iat``..``exp`` span (the
 * sliding-session mark). A payload without a usable ``iat`` gets the
 * buffer mark alone.
 */
export function refreshDeadlineMs(payload: JwtPayload): number {
  const bufferDeadlineMs = (payload.exp - REFRESH_BUFFER_SECONDS) * MS_PER_SECOND;
  if (typeof payload.iat !== 'number' || payload.iat >= payload.exp) return bufferDeadlineMs;
  const halfLifeMs =
    (payload.iat + (payload.exp - payload.iat) * SLIDING_RENEWAL_FRACTION) * MS_PER_SECOND;
  return Math.min(bufferDeadlineMs, halfLifeMs);
}

/**
 * Check whether a token should be proactively refreshed.
 * Returns true once ``refreshDeadlineMs`` has passed, or for an unparseable token.
 */
export function shouldRefreshToken(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  return refreshDeadlineMs(payload) <= Date.now();
}
