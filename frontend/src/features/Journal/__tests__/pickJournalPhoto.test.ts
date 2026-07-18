/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as ImagePicker from 'expo-image-picker';

import { pickJournalPhoto, toMediaType } from '../pickJournalPhoto';

const requestPermission = jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync);
const launchLibrary = jest.mocked(ImagePicker.launchImageLibraryAsync);

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

describe('pickJournalPhoto', () => {
  beforeEach(() => {
    requestPermission.mockResolvedValue({ granted: true } as ImagePicker.PermissionResponse);
    launchLibrary.mockResolvedValue({ canceled: true, assets: null });
  });

  it('returns denied without launching the picker when permission is refused', async () => {
    requestPermission.mockResolvedValueOnce({ granted: false } as ImagePicker.PermissionResponse);
    expect(await pickJournalPhoto()).toEqual({ kind: 'denied' });
    expect(launchLibrary).not.toHaveBeenCalled();
  });

  it('returns cancelled when the user backs out of the picker', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickJournalPhoto()).toEqual({ kind: 'cancelled' });
  });

  it('returns failed when a completed pick has no assets', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [] });
    expect(await pickJournalPhoto()).toEqual({ kind: 'failed' });
  });

  it('returns failed when the picked asset carries no base64 data', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [asset({ base64: null })] });
    expect(await pickJournalPhoto()).toEqual({ kind: 'failed' });
  });

  it('returns failed when the picked asset omits base64 entirely', async () => {
    const noBase64 = asset();
    delete (noBase64 as { base64?: string | null }).base64;
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [noBase64] });
    expect(await pickJournalPhoto()).toEqual({ kind: 'failed' });
  });

  it('returns the base64 payload + resolved media type on a successful pick', async () => {
    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [asset({ base64: 'xyz', mimeType: 'image/png' })],
    });
    expect(await pickJournalPhoto()).toEqual({
      kind: 'picked',
      imageBase64: 'xyz',
      mediaType: 'image/png',
    });
  });

  it('requests images-only, base64-included, 0.8-quality media', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [asset()] });
    await pickJournalPhoto();
    expect(launchLibrary).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 0.8,
      base64: true,
    });
  });

  it('never calls the launcher after permission is denied', async () => {
    requestPermission.mockResolvedValueOnce({ granted: false } as ImagePicker.PermissionResponse);
    await pickJournalPhoto();
    expect(launchLibrary).not.toHaveBeenCalled();
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
