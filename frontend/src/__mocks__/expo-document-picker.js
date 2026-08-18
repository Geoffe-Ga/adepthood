/* global jest */
// Jest mock for ``expo-document-picker``: the native module cannot load in the
// test environment. Tests override the resolved value per-case with
// ``mockResolvedValueOnce`` to drive the cancel / pick / empty branches.
//
// The default is a cancelled pick, so a test that forgets to arm the picker
// gets the inert outcome rather than a fabricated document.

module.exports = {
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true, assets: null }),
};
