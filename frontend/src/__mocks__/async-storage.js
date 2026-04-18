/* eslint-env jest */
/* global jest */

let store = {};

const asyncStorageMock = {
  setItem: jest.fn((key, value) => {
    store[key] = String(value);
    return Promise.resolve();
  }),
  getItem: jest.fn((key) => Promise.resolve(store[key] === undefined ? null : store[key])),
  removeItem: jest.fn((key) => {
    delete store[key];
    return Promise.resolve();
  }),
  clear: jest.fn(() => {
    store = {};
    return Promise.resolve();
  }),
  getAllKeys: jest.fn(() => Promise.resolve(Object.keys(store))),
  multiGet: jest.fn((keys) => Promise.resolve(keys.map((key) => [key, store[key] ?? null]))),
  multiSet: jest.fn((pairs) => {
    for (const [key, value] of pairs) {
      store[key] = String(value);
    }
    return Promise.resolve();
  }),
  multiRemove: jest.fn((keys) => {
    for (const key of keys) delete store[key];
    return Promise.resolve();
  }),
  mergeItem: jest.fn(() => Promise.resolve()),
  flushGetRequests: jest.fn(),
  __INTERNAL_MOCK_STORAGE__: store,
};

module.exports = asyncStorageMock;
module.exports.default = asyncStorageMock;
