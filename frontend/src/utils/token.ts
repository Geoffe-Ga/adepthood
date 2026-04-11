import { toByteArray } from 'base64-js';

/** Seconds before expiration at which we proactively refresh the token. */
export const REFRESH_BUFFER_SECONDS = 5 * 60;

interface JwtPayload {
  sub: string;
  exp: number;
  iat: number;
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
 * Check whether a token should be proactively refreshed.
 * Returns true if expiration is within the REFRESH_BUFFER_SECONDS window.
 */
export function shouldRefreshToken(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  const expiresAtMs = payload.exp * 1000;
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return expiresAtMs - Date.now() <= bufferMs;
}
