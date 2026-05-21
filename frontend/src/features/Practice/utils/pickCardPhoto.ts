// Wraps `expo-image-picker` so the configurator imports a single function.

import * as ImagePicker from 'expo-image-picker';

/** A photo the user picked from their device's media library. */
export interface PickedPhoto {
  /** Device-local URI (`file://`, `content://`, `ph://`, `asset://`). */
  readonly uri: string;
}

/**
 * Open the media library and return the chosen photo.
 *
 * Requests media-library permission on first use. Returns `null` when the
 * user denies permission or cancels the picker — callers treat both as a
 * no-op rather than an error. V1 does not upload the photo: the returned
 * `uri` is a device path stored as-is in the practice config.
 */
export async function pickCardPhoto(): Promise<PickedPhoto | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
  });
  if (result.canceled) {
    return null;
  }
  const asset = result.assets[0];
  return asset ? { uri: asset.uri } : null;
}
