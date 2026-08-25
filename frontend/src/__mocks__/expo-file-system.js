/* global jest */
// Jest mock for ``expo-file-system``: the native module cannot load in the test
// environment.
//
// Mirrors the SDK 57 surface the app actually uses -- ``new File(...uris)``
// with a synchronous ``delete()``/``create()``/``write()`` and an ``exists``
// getter, plus ``Paths.cache`` and ``Paths.document``. The retired
// ``deleteAsync``/``cacheDirectory`` are deliberately absent: they still
// type-check (expo re-exports them from ``legacyWarnings.d.ts``) but throw at
// runtime, so leaving them out of the mock is what keeps a regression visible.
//
// The constructor joins its arguments the way the real one does, so a test can
// tell ``new File(Paths.document, 'a.json')`` from a hard-coded path and a
// caller that forgot the directory produces a different uri here too.
//
// ``__deleteFile``, ``__fileExists``, ``__fileSize``, ``__fileBase64``,
// ``__createFile`` and ``__writeFile`` are the spies behind the class, so tests
// can assert which uris were deleted or written, drive the missing-file and
// delete-failure branches, and stand in for a document's on-device size and
// encoded contents.

const __deleteFile = jest.fn();
const __fileExists = jest.fn(() => true);
const __fileSize = jest.fn(() => 0);
const __fileBase64 = jest.fn(() => Promise.resolve(''));
const __createFile = jest.fn();
const __writeFile = jest.fn();

function joinUris(parts) {
  return parts
    .map((part) => (typeof part === 'string' ? part : (part && part.uri) || ''))
    .filter((part) => part !== '')
    .reduce(
      (base, next) =>
        base === '' ? next : `${base.replace(/\/+$/, '')}/${next.replace(/^\/+/, '')}`,
      '',
    );
}

class File {
  constructor(...uris) {
    this.uri = joinUris(uris);
  }

  get exists() {
    return __fileExists(this.uri);
  }

  get size() {
    return __fileSize(this.uri);
  }

  base64() {
    return __fileBase64(this.uri);
  }

  create(options) {
    __createFile(this.uri, options);
  }

  write(contents) {
    __writeFile(this.uri, contents);
  }

  delete() {
    __deleteFile(this.uri);
  }
}

module.exports = {
  File,
  Paths: { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///documents/' } },
  __deleteFile,
  __fileExists,
  __fileSize,
  __fileBase64,
  __createFile,
  __writeFile,
};
