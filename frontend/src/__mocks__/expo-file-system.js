/* global jest */
// Jest mock for ``expo-file-system``: the native module cannot load in the test
// environment.
//
// Mirrors the SDK 57 surface the app actually uses -- ``new File(uri)`` with a
// synchronous ``delete()`` and an ``exists`` getter, plus ``Paths.cache``. The
// retired ``deleteAsync``/``cacheDirectory`` are deliberately absent: they still
// type-check (expo re-exports them from ``legacyWarnings.d.ts``) but throw at
// runtime, so leaving them out of the mock is what keeps a regression visible.
//
// ``__deleteFile`` and ``__fileExists`` are the spies behind the class, so tests
// can assert which uris were deleted and drive the missing-file and
// delete-failure branches.

const __deleteFile = jest.fn();
const __fileExists = jest.fn(() => true);

class File {
  constructor(uri) {
    this.uri = uri;
  }

  get exists() {
    return __fileExists(this.uri);
  }

  delete() {
    __deleteFile(this.uri);
  }
}

module.exports = {
  File,
  Paths: { cache: { uri: 'file:///cache/' } },
  __deleteFile,
  __fileExists,
};
