/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as ImagePicker from 'expo-image-picker';

import { captureJournalPhoto, pickJournalPhotos } from '../pickJournalPhoto';

const requestPermission = jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync);
const launchLibrary = jest.mocked(ImagePicker.launchImageLibraryAsync);
const requestCameraPermission = jest.mocked(ImagePicker.requestCameraPermissionsAsync);
const launchCamera = jest.mocked(ImagePicker.launchCameraAsync);

// The factory keeps legacy base64/mimeType metadata on purpose: a picker may
// still report them, and the mapper must ignore them rather than pass them on.
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

  it('returns failed when zero picked assets carry a file uri', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ uri: '' })],
    });
    expect(await pickJournalPhotos(10)).toEqual({ kind: 'failed' });
  });

  it('maps every picked asset, in selection order, to its uri alone', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        asset({ uri: 'file:///p1.jpg', mimeType: 'image/jpeg' }),
        asset({ uri: 'file:///p2.jpg', mimeType: 'image/png' }),
        asset({ uri: 'file:///p3.jpg', mimeType: 'image/webp' }),
      ],
    });

    expect(await pickJournalPhotos(10)).toEqual({
      kind: 'picked',
      assets: [{ uri: 'file:///p1.jpg' }, { uri: 'file:///p2.jpg' }, { uri: 'file:///p3.jpg' }],
    });
  });

  it('skips a uri-less asset among otherwise usable picks, returning only the usable ones', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        asset({ uri: 'file:///p1.jpg' }),
        asset({ uri: '' }),
        asset({ uri: 'file:///p3.jpg' }),
      ],
    });

    expect(await pickJournalPhotos(10)).toEqual({
      kind: 'picked',
      assets: [{ uri: 'file:///p1.jpg' }, { uri: 'file:///p3.jpg' }],
    });
  });

  it('calls the launcher with exactly the multi-select options for the given selection limit', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [asset()] });
    await pickJournalPhotos(7);
    expect(launchLibrary).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 7,
      orderedSelection: true,
    });
  });

  it('never requests base64 or a quality re-encode from the library picker', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [asset()] });
    await pickJournalPhotos(10);
    expect(launchLibrary).toHaveBeenCalledTimes(1);
    const [options] = launchLibrary.mock.calls[0] ?? [];
    expect(options ?? {}).not.toHaveProperty('base64');
    expect(options ?? {}).not.toHaveProperty('quality');
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

  it('returns failed when the captured asset carries no file uri', async () => {
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ uri: '' })],
    });
    expect(await captureJournalPhoto()).toEqual({ kind: 'failed' });
  });

  it('maps a granted capture to its uri alone, ignoring any picker-reported metadata', async () => {
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ uri: 'file:///cam.jpg', base64: 'cam-b64', mimeType: 'image/png' })],
    });
    expect(await captureJournalPhoto()).toEqual({
      kind: 'captured',
      asset: { uri: 'file:///cam.jpg' },
    });
  });

  it('never requests base64 or a quality re-encode from the camera', async () => {
    launchCamera.mockResolvedValueOnce({ canceled: false, assets: [asset()] });
    await captureJournalPhoto();
    expect(launchCamera).toHaveBeenCalledTimes(1);
    const [options] = launchCamera.mock.calls[0] ?? [];
    expect(options ?? {}).not.toHaveProperty('base64');
    expect(options ?? {}).not.toHaveProperty('quality');
  });
});
