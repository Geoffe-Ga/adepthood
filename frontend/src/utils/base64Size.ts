/**
 * The decoded size of a base64 payload, computed without decoding it — the one
 * measurement every client-side upload gate needs, and the one place it is
 * derived so a second copy cannot drift from a backend cap.
 */

/** Every base64 group of 4 encoded characters carries 3 decoded bytes. */
const BASE64_CHARS_PER_GROUP = 4;
const BASE64_BYTES_PER_GROUP = 3;

/**
 * The decoded byte size of a base64 payload: each 4-character group encodes 3
 * bytes, minus one byte for every trailing `=` padding character.
 */
export function decodedBase64ByteLength(base64: string): number {
  let paddingBytes = 0;
  if (base64.endsWith('==')) {
    paddingBytes = 2;
  } else if (base64.endsWith('=')) {
    paddingBytes = 1;
  }
  return (base64.length / BASE64_CHARS_PER_GROUP) * BASE64_BYTES_PER_GROUP - paddingBytes;
}
