/**
 * Wraps `expo-image-picker` for the Journal photograph-capture flow: request
 * permission, open the library for an ordered multi-selection or the camera for
 * a single page, and hand back the pages as base64 with server-accepted media
 * types — or a discriminated reason none were usable.
 *
 * PRIVACY: the returned base64 image payloads are never logged here; callers hold
 * them in memory only and release them once the pages are saved.
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

/** A single usable page returned from the picker: its uri, base64, and media type. */
export interface PickedAsset {
  uri: string;
  imageBase64: string;
  mediaType: MediaType;
}

/**
 * The outcome of a multi-pick attempt, discriminated on `kind`:
 *
 *  - `denied`    — media-library permission was refused; the picker never opened.
 *  - `cancelled` — the user backed out of the picker.
 *  - `failed`    — the pick completed but yielded no usable base64 image.
 *  - `picked`    — one or more usable pages, in selection order.
 */
export type MultiPickResult =
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'picked'; assets: PickedAsset[] };

/**
 * Map an image picker mime type to a transcription-accepted {@link MediaType}.
 * Known encodings pass through unchanged; anything else (or a missing mime)
 * defaults to `image/jpeg`, the safest broadly-supported fallback.
 */
export function toMediaType(mime?: string): MediaType {
  const match = PASSTHROUGH_MEDIA_TYPES.find((accepted) => accepted === mime);
  return match ?? DEFAULT_MEDIA_TYPE;
}

/** Keep only assets that carry base64, mapping each to a {@link PickedAsset} in order. */
function toPickedAssets(assets: readonly ImagePicker.ImagePickerAsset[]): PickedAsset[] {
  const usable: PickedAsset[] = [];
  for (const asset of assets) {
    if (asset.base64) {
      usable.push({
        uri: asset.uri,
        imageBase64: asset.base64,
        mediaType: toMediaType(asset.mimeType),
      });
    }
  }
  return usable;
}

/**
 * Open the device media library for an ordered multi-selection and return the
 * chosen pages as base64.
 *
 * Requests media-library permission first; a refusal short-circuits to `denied`
 * without ever launching the picker. A cancelled pick is `cancelled`. Every
 * picked asset carrying base64 is mapped, in selection order, to its uri, base64,
 * and resolved media type; assets without base64 are skipped. A pick that yields
 * no usable asset is `failed`. `selectionLimit` caps how many pages the picker
 * offers — the session's remaining capacity.
 */
export async function pickJournalPhotos(selectionLimit: number): Promise<MultiPickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied' };
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: IMAGE_QUALITY,
    base64: true,
    allowsMultipleSelection: true,
    selectionLimit,
    orderedSelection: true,
  });
  if (result.canceled) {
    return { kind: 'cancelled' };
  }
  const assets = toPickedAssets(result.assets);
  if (assets.length === 0) {
    return { kind: 'failed' };
  }
  return { kind: 'picked', assets };
}

/**
 * The outcome of a single camera capture, discriminated on `kind`:
 *
 *  - `denied`    — camera permission was refused; the camera never opened.
 *  - `cancelled` — the user backed out of the camera.
 *  - `failed`    — the capture completed but yielded no usable base64 image.
 *  - `captured`  — one usable page, ready to append to the session.
 */
export type CaptureResult =
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'captured'; asset: PickedAsset };

/**
 * Open the device camera to photograph a single page and return it as base64.
 *
 * Requests camera permission first; a refusal short-circuits to `denied` without
 * ever launching the camera. A dismissed camera is `cancelled`. A captured asset
 * carrying base64 is mapped to its uri, base64, and resolved media type; a
 * capture that yields no usable asset is `failed`.
 *
 * PRIVACY: the returned base64 image payload is never logged here; the caller
 * holds it in memory only and releases it once the page is saved.
 */
export async function captureJournalPhoto(): Promise<CaptureResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied' };
  }
  const result = await ImagePicker.launchCameraAsync({
    quality: IMAGE_QUALITY,
    base64: true,
  });
  if (result.canceled) {
    return { kind: 'cancelled' };
  }
  const [asset] = toPickedAssets(result.assets);
  if (!asset) {
    return { kind: 'failed' };
  }
  return { kind: 'captured', asset };
}
