/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as ImagePicker from 'expo-image-picker';

import { captureJournalPhoto, pickJournalPhotos, toMediaType } from '../pickJournalPhoto';

const requestPermission = jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync);
const launchLibrary = jest.mocked(ImagePicker.launchImageLibraryAsync);
const requestCameraPermission = jest.mocked(ImagePicker.requestCameraPermissionsAsync);
const launchCamera = jest.mocked(ImagePicker.launchCameraAsync);

function asset(
  overrides: Partial<ImagePicker.ImagePickerAsset> = {},
): ImagePicker.ImagePickerAsset {
  return {
    uri: 'file:///page.jpg',
    width: 1,
    height: 1,
    base64: 'abc123',
    mimeType: 'image/jpeg',
    ...overrides,
  } as ImagePicker.ImagePickerAsset;
}

describe('pickJournalPhotos', () => {
  beforeEach(() => {
    requestPermission.mockResolvedValue({ granted: true } as ImagePicker.PermissionResponse);
    launchLibrary.mockResolvedValue({ canceled: true, assets: null });
  });

  it('returns denied without launching the picker when permission is refused', async () => {
    requestPermission.mockResolvedValueOnce({ granted: false } as ImagePicker.PermissionResponse);
    expect(await pickJournalPhotos(10)).toEqual({ kind: 'denied' });
    expect(launchLibrary).not.toHaveBeenCalled();
  });

  it('returns cancelled when the user backs out of the picker', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickJournalPhotos(10)).toEqual({ kind: 'cancelled' });
  });

  it('returns failed when zero picked assets carry usable base64 data', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ base64: undefined })],
    });
    expect(await pickJournalPhotos(10)).toEqual({ kind: 'failed' });
  });

  it('maps every picked asset, in selection order, to uri + imageBase64 + mediaType', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        asset({ uri: 'file:///p1.jpg', base64: 'b64-1', mimeType: 'image/jpeg' }),
        asset({ uri: 'file:///p2.jpg', base64: 'b64-2', mimeType: 'image/png' }),
        asset({ uri: 'file:///p3.jpg', base64: 'b64-3', mimeType: 'image/webp' }),
      ],
    });

    expect(await pickJournalPhotos(10)).toEqual({
      kind: 'picked',
      assets: [
        { uri: 'file:///p1.jpg', imageBase64: 'b64-1', mediaType: 'image/jpeg' },
        { uri: 'file:///p2.jpg', imageBase64: 'b64-2', mediaType: 'image/png' },
        { uri: 'file:///p3.jpg', imageBase64: 'b64-3', mediaType: 'image/webp' },
      ],
    });
  });

  it('skips a base64-less asset among otherwise usable picks, returning only the usable ones', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        asset({ uri: 'file:///p1.jpg', base64: 'b64-1' }),
        asset({ uri: 'file:///p2.jpg', base64: undefined }),
        asset({ uri: 'file:///p3.jpg', base64: 'b64-3' }),
      ],
    });

    expect(await pickJournalPhotos(10)).toEqual({
      kind: 'picked',
      assets: [
        { uri: 'file:///p1.jpg', imageBase64: 'b64-1', mediaType: 'image/jpeg' },
        { uri: 'file:///p3.jpg', imageBase64: 'b64-3', mediaType: 'image/jpeg' },
      ],
    });
  });

  it('calls the launcher with multi-select options for the given selection limit', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [asset()] });
    await pickJournalPhotos(7);
    expect(launchLibrary).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 0.8,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit: 7,
      orderedSelection: true,
    });
  });

  it('never calls the launcher after permission is denied', async () => {
    requestPermission.mockResolvedValueOnce({ granted: false } as ImagePicker.PermissionResponse);
    await pickJournalPhotos(10);
    expect(launchLibrary).not.toHaveBeenCalled();
  });
});

describe('captureJournalPhoto', () => {
  beforeEach(() => {
    requestCameraPermission.mockResolvedValue({
      granted: true,
    } as ImagePicker.PermissionResponse);
    launchCamera.mockResolvedValue({ canceled: true, assets: null });
  });

  it('returns denied without launching the camera when permission is refused', async () => {
    requestCameraPermission.mockResolvedValueOnce({
      granted: false,
    } as ImagePicker.PermissionResponse);
    expect(await captureJournalPhoto()).toEqual({ kind: 'denied' });
    expect(launchCamera).not.toHaveBeenCalled();
  });

  it('returns cancelled when the user backs out of the camera', async () => {
    launchCamera.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await captureJournalPhoto()).toEqual({ kind: 'cancelled' });
  });

  it('returns failed when the captured asset carries no usable base64 data', async () => {
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ base64: undefined })],
    });
    expect(await captureJournalPhoto()).toEqual({ kind: 'failed' });
  });

  it('maps a granted capture to uri + imageBase64 + mediaType, passing image/png through', async () => {
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ uri: 'file:///cam.png', base64: 'cam-b64', mimeType: 'image/png' })],
    });
    expect(await captureJournalPhoto()).toEqual({
      kind: 'captured',
      asset: { uri: 'file:///cam.png', imageBase64: 'cam-b64', mediaType: 'image/png' },
    });
  });

  it('defaults an absent mime type to image/jpeg on a captured asset', async () => {
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ uri: 'file:///cam.jpg', base64: 'cam-b64', mimeType: undefined })],
    });
    expect(await captureJournalPhoto()).toEqual({
      kind: 'captured',
      asset: { uri: 'file:///cam.jpg', imageBase64: 'cam-b64', mediaType: 'image/jpeg' },
    });
  });

  it('defaults an unrecognized mime type to image/jpeg on a captured asset', async () => {
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ uri: 'file:///cam.heic', base64: 'cam-b64', mimeType: 'image/heic' })],
    });
    expect(await captureJournalPhoto()).toEqual({
      kind: 'captured',
      asset: { uri: 'file:///cam.heic', imageBase64: 'cam-b64', mediaType: 'image/jpeg' },
    });
  });

  it('calls the camera launcher with exactly quality and base64 options', async () => {
    launchCamera.mockResolvedValueOnce({ canceled: false, assets: [asset()] });
    await captureJournalPhoto();
    expect(launchCamera).toHaveBeenCalledWith({ quality: 0.8, base64: true });
  });
});

describe('toMediaType', () => {
  it('maps image/png through unchanged', () => {
    expect(toMediaType('image/png')).toBe('image/png');
  });

  it('maps image/webp through unchanged', () => {
    expect(toMediaType('image/webp')).toBe('image/webp');
  });

  it('maps image/jpeg through unchanged', () => {
    expect(toMediaType('image/jpeg')).toBe('image/jpeg');
  });

  it('defaults an unrecognized mime type to image/jpeg', () => {
    expect(toMediaType('image/heic')).toBe('image/jpeg');
  });

  it('defaults an absent mime type to image/jpeg', () => {
    expect(toMediaType(undefined)).toBe('image/jpeg');
  });
});
