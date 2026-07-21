/* global jest */
// Jest mock for ``expo-file-system``: the native module cannot load in the
// test environment. Tests override ``deleteAsync`` per-case (e.g. with
// ``mockRejectedValueOnce``) to drive cleanup failure branches.

module.exports = {
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  cacheDirectory: 'file:///cache/',
};
