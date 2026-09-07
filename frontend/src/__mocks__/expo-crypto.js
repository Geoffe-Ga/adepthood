/* eslint-env jest */
/* global jest */

module.exports = {
  getRandomBytesAsync: jest.fn((length) => Promise.resolve(new Uint8Array(length))),
};
