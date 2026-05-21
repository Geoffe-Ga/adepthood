import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as ImagePicker from 'expo-image-picker';

import { pickCardPhoto } from '../pickCardPhoto';

const requestPermission = jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync);
const launchLibrary = jest.mocked(ImagePicker.launchImageLibraryAsync);

function asset(uri: string): ImagePicker.ImagePickerAsset {
  return { uri, width: 1, height: 1 } as ImagePicker.ImagePickerAsset;
}

describe('pickCardPhoto', () => {
  beforeEach(() => {
    requestPermission.mockResolvedValue({ granted: true } as ImagePicker.PermissionResponse);
    launchLibrary.mockResolvedValue({ canceled: true, assets: null });
  });

  it('returns null when media-library permission is denied', async () => {
    requestPermission.mockResolvedValueOnce({ granted: false } as ImagePicker.PermissionResponse);
    expect(await pickCardPhoto()).toBeNull();
    expect(launchLibrary).not.toHaveBeenCalled();
  });

  it('returns null when the picker is cancelled', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickCardPhoto()).toBeNull();
  });

  it('returns the chosen photo uri on a successful pick', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [asset('file:///pick.jpg')] });
    expect(await pickCardPhoto()).toEqual({ uri: 'file:///pick.jpg' });
  });

  it('returns null when a successful pick yields no asset', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [] });
    expect(await pickCardPhoto()).toBeNull();
  });
});
