/**
 * Wraps `expo-image-picker` for the Journal photograph-capture flow: request
 * permission, open the library for an ordered multi-selection or the camera
 * for a single page, and hand back each usable page's file uri — or a
 * discriminated reason none were usable.
 *
 * The picker itself never re-encodes: no quality option, no base64 request.
 * Downscaling and encoding happen once, in the capture pipeline's prepare
 * step, working from the uris returned here.
 */
import * as ImagePicker from 'expo-image-picker';

/** A single usable page returned from the picker: its on-device file uri. */
export interface PickedAsset {
  uri: string;
}

/**
 * The outcome of a multi-pick attempt, discriminated on `kind`:
 *
 *  - `denied`    — media-library permission was refused; the picker never opened.
 *  - `cancelled` — the user backed out of the picker.
 *  - `failed`    — the pick completed but yielded no asset with a file uri.
 *  - `picked`    — one or more usable pages, in selection order.
 */
export type MultiPickResult =
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'picked'; assets: PickedAsset[] };

/** Keep only assets that carry a file uri, mapping each to a {@link PickedAsset}
 *  in order; any legacy picker-reported metadata (base64, mime) is ignored. */
function toPickedAssets(assets: readonly ImagePicker.ImagePickerAsset[]): PickedAsset[] {
  const usable: PickedAsset[] = [];
  for (const asset of assets) {
    if (asset.uri) {
      usable.push({ uri: asset.uri });
    }
  }
  return usable;
}

/**
 * Open the device media library for an ordered multi-selection and return the
 * chosen pages' file uris.
 *
 * Requests media-library permission first; a refusal short-circuits to `denied`
 * without ever launching the picker. A cancelled pick is `cancelled`. Every
 * picked asset carrying a file uri is mapped, in selection order; assets
 * without one are skipped. A pick that yields no usable asset is `failed`.
 * `selectionLimit` caps how many pages the picker offers — the session's
 * remaining capacity.
 */
export async function pickJournalPhotos(selectionLimit: number): Promise<MultiPickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied' };
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
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
 *  - `failed`    — the capture completed but yielded no asset with a file uri.
 *  - `captured`  — one usable page, ready to append to the session.
 */
export type CaptureResult =
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'captured'; asset: PickedAsset };

/**
 * Open the device camera to photograph a single page and return its file uri.
 *
 * Requests camera permission first; a refusal short-circuits to `denied`
 * without ever launching the camera. A dismissed camera is `cancelled`. A
 * captured asset carrying a file uri is mapped to it; a capture that yields
 * no usable asset is `failed`.
 */
export async function captureJournalPhoto(): Promise<CaptureResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied' };
  }
  const result = await ImagePicker.launchCameraAsync();
  if (result.canceled) {
    return { kind: 'cancelled' };
  }
  const [asset] = toPickedAssets(result.assets);
  if (!asset) {
    return { kind: 'failed' };
  }
  return { kind: 'captured', asset };
}
