/* global jest */
// Jest mock for ``expo-image-manipulator``: the native module cannot load in
// the test environment. ``ImageManipulator.manipulate(uri)`` yields a chainable
// context whose ``renderAsync()`` resolves to an image ref carrying dimensions
// and a ``saveAsync``. Tests override ``manipulate`` per-case (via
// ``jest.mocked(...).mockReturnValue``) to control the reported dimensions and
// the saved uri/base64.

function makeImageRef() {
  return {
    width: 1000,
    height: 800,
    saveAsync: jest.fn().mockResolvedValue({
      uri: 'file:///cache/manipulated/default.jpg',
      width: 1000,
      height: 800,
      base64: 'ZGVmYXVsdA==',
    }),
  };
}

function makeContext() {
  const context = {
    resize: jest.fn(),
    renderAsync: jest.fn(),
  };
  context.resize.mockReturnValue(context);
  context.renderAsync.mockResolvedValue(makeImageRef());
  return context;
}

module.exports = {
  ImageManipulator: {
    manipulate: jest.fn(() => makeContext()),
  },
  SaveFormat: {
    JPEG: 'jpeg',
    PNG: 'png',
    WEBP: 'webp',
  },
};
