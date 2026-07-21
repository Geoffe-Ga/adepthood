/* global jest */
// Jest mock for ``expo-image-picker``: the native module cannot load in
// the test environment. Tests override these per-case with
// ``mockResolvedValueOnce`` to drive permission/cancel/pick branches.

module.exports = {
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true, assets: null }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: true, assets: null }),
};
