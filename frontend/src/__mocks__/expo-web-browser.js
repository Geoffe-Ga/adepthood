/* eslint-env jest */
/* global jest */
module.exports = {
  maybeCompleteAuthSession: jest.fn(() => ({ type: 'failed', message: 'not_supported' })),
  warmUpAsync: jest.fn(() => Promise.resolve()),
  coolDownAsync: jest.fn(() => Promise.resolve()),
  dismissAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(() => Promise.resolve({ type: 'dismiss' })),
};
