/**
 * Coerce an unknown thrown value into an `Error` — passes real errors through
 * by reference and wraps everything else via `String(value)`.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
