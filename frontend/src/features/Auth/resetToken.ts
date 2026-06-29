/**
 * Minimum length of a backend-issued password-reset token (matches the server's
 * token generator). Shared by the reset-password and cancel-reset screens so the
 * client-side "looks valid" guard stays identical on both.
 */
export const MIN_TOKEN_LENGTH = 32;
