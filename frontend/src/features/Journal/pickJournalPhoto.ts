/**
 * Wraps `expo-image-picker` for the Journal photograph-capture flow: request
 * permission, open the library, and hand back the picked page as base64 with a
 * server-accepted media type — or a discriminated reason it did not.
 *
 * PRIVACY: the returned base64 image payload is never logged here; callers hold
 * it in memory only and release it once the page is saved.
 */
import * as ImagePicker from 'expo-image-picker';

import type { MediaType } from '@/api';

// Slight compression: a full-resolution page photo can be several MB, and the
// transcription request carries the base64 inline. 0.8 is visually lossless for
// legible handwriting while keeping the upload small.
const IMAGE_QUALITY = 0.8;

/** The media types the transcription endpoint accepts, unchanged when mapped. */
const PASSTHROUGH_MEDIA_TYPES: readonly MediaType[] = ['image/png', 'image/webp', 'image/jpeg'];

/** Default encoding assumed when the picker reports an unknown/absent mime type. */
const DEFAULT_MEDIA_TYPE: MediaType = 'image/jpeg';

/**
 * The outcome of a single pick attempt, discriminated on `kind`:
 *
 *  - `denied`    — media-library permission was refused; the picker never opened.
 *  - `cancelled` — the user backed out of the picker.
 *  - `failed`    — the pick completed but yielded no usable base64 image.
 *  - `picked`    — a usable page image with its resolved media type.
 */
export type PickResult =
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'picked'; imageBase64: string; mediaType: MediaType };

/**
 * Map an image picker mime type to a transcription-accepted {@link MediaType}.
 * Known encodings pass through unchanged; anything else (or a missing mime)
 * defaults to `image/jpeg`, the safest broadly-supported fallback.
 */
export function toMediaType(mime?: string): MediaType {
  const match = PASSTHROUGH_MEDIA_TYPES.find((accepted) => accepted === mime);
  return match ?? DEFAULT_MEDIA_TYPE;
}

/**
 * Open the device media library and return the chosen page as base64.
 *
 * Requests media-library permission first; a refusal short-circuits to `denied`
 * without ever launching the picker. A cancelled pick is `cancelled`; a pick
 * that yields no asset or no base64 is `failed`. Otherwise the first asset's
 * base64 payload and resolved media type are returned as `picked`.
 */
export async function pickJournalPhoto(): Promise<PickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied' };
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: IMAGE_QUALITY,
    base64: true,
  });
  if (result.canceled) {
    return { kind: 'cancelled' };
  }
  const asset = result.assets[0];
  if (!asset || !asset.base64) {
    return { kind: 'failed' };
  }
  return { kind: 'picked', imageBase64: asset.base64, mediaType: toMediaType(asset.mimeType) };
}
