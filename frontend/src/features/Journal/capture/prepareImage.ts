/**
 * Client-side page preparation for transcription: load a photographed journal
 * page, downscale it to the transcription model's effective resolution, and
 * re-encode it once as a compact JPEG. Shipping more pixels than the model can
 * use only slows the upload and inflates the request, so the downscale happens
 * on device, before anything leaves it.
 *
 * The whole pipeline performs exactly one encode: the manipulator context is
 * rendered, optionally resized, and saved a single time with an inline base64
 * payload.
 *
 * PRIVACY: the returned base64 payload IS the page image. It is never logged
 * here and must live in memory only (the capture session's reducer state),
 * released once the page is transcribed, removed, or abandoned.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageRef } from 'expo-image-manipulator';

/**
 * The longest edge, in pixels, worth sending for transcription. Larger pages
 * are downscaled (preserving aspect ratio) because the vision model resamples
 * anything bigger to this size anyway — extra pixels buy nothing.
 */
export const TRANSCRIBE_LONG_EDGE_PX = 1568;

/**
 * JPEG compression for the prepared page: visually lossless for legible
 * handwriting while keeping the inline upload small.
 */
export const TRANSCRIBE_JPEG_QUALITY = 0.8;

/**
 * The transcription endpoint's decoded-image request cap, in bytes — the same
 * value the backend router enforces. A page is allowed through only when its
 * payload is strictly under this cap, so an oversize page is caught on device
 * without spending the round-trip. Rejecting at exactly the cap is one byte
 * stricter than the server (which rejects only above it): conservative on
 * purpose, so a borderline page never becomes a doomed request.
 */
export const MAX_TRANSCRIBE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Every base64 group of 4 encoded characters carries 3 decoded bytes. */
const BASE64_CHARS_PER_GROUP = 4;
const BASE64_BYTES_PER_GROUP = 3;

/** A page downscaled and re-encoded for the transcription request. */
export interface PreparedPage {
  /** The JPEG image, base64-encoded, ready for the request body. */
  base64: string;
  /** Always JPEG — the one format the prepare step saves. */
  mediaType: 'image/jpeg';
  /** Decoded size of {@link base64} in bytes, for the upload-cap gate. */
  byteLength: number;
  /** The manipulator-output file holding the prepared image on device. */
  uri: string;
}

/**
 * The decoded byte size of a base64 payload, computed without decoding it:
 * each 4-character group encodes 3 bytes, minus one byte for every trailing
 * `=` padding character.
 */
function decodedBase64ByteLength(base64: string): number {
  let paddingBytes = 0;
  if (base64.endsWith('==')) {
    paddingBytes = 2;
  } else if (base64.endsWith('=')) {
    paddingBytes = 1;
  }
  return (base64.length / BASE64_CHARS_PER_GROUP) * BASE64_BYTES_PER_GROUP - paddingBytes;
}

/**
 * The resize the rendered page needs, or null when it already fits: the longer
 * edge (of the EXIF-normalized render, not any stored-file metadata) shrinks
 * to {@link TRANSCRIBE_LONG_EDGE_PX} and the other follows to preserve ratio.
 * Pages within the limit are never upscaled.
 */
function longEdgeResize(image: ImageRef): { width: number } | { height: number } | null {
  if (Math.max(image.width, image.height) <= TRANSCRIBE_LONG_EDGE_PX) {
    return null;
  }
  return image.width >= image.height
    ? { width: TRANSCRIBE_LONG_EDGE_PX }
    : { height: TRANSCRIBE_LONG_EDGE_PX };
}

/**
 * Downscale one page photo for transcription and encode it exactly once.
 *
 * Loads the source through the image manipulator, renders it to learn its
 * normalized dimensions, resizes only when the long edge exceeds
 * {@link TRANSCRIBE_LONG_EDGE_PX}, and saves a single JPEG with an inline
 * base64 payload.
 *
 * PRIVACY: the resolved value carries the page image as base64; callers hold
 * it in reducer state only — never navigation params, never logs.
 */
export async function preparePageForTranscription(uri: string): Promise<PreparedPage> {
  const context = ImageManipulator.manipulate(uri);
  let rendered = await context.renderAsync();
  const resize = longEdgeResize(rendered);
  if (resize) {
    rendered = await context.resize(resize).renderAsync();
  }
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: TRANSCRIBE_JPEG_QUALITY,
    base64: true,
  });
  if (saved.base64 === undefined) {
    // The manipulator was asked for base64; a missing payload is a real fault
    // the caller routes to its unreadable-photo offramp.
    throw new Error('image save produced no base64 payload');
  }
  return {
    base64: saved.base64,
    mediaType: 'image/jpeg',
    byteLength: decodedBase64ByteLength(saved.base64),
    uri: saved.uri,
  };
}
