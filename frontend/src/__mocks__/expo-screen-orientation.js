/* global jest */
// Mirrors the subset of expo-screen-orientation the app uses. The numeric
// values match the real enum so a test asserting PORTRAIT_UP cannot pass
// against PORTRAIT by accident.
const OrientationLock = {
  DEFAULT: 0,
  ALL: 1,
  PORTRAIT: 2,
  PORTRAIT_UP: 3,
  PORTRAIT_DOWN: 4,
  LANDSCAPE: 5,
};

module.exports = {
  OrientationLock,
  lockAsync: jest.fn().mockResolvedValue(undefined),
  unlockAsync: jest.fn().mockResolvedValue(undefined),
};
