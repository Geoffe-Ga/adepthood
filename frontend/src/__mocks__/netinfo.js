/* global jest */
/**
 * Jest mock for @react-native-community/netinfo. Returns a static "connected"
 * state so tests can render the NetworkStatusProvider without pulling in the
 * native module that only exists in a real RN runtime.
 */
const state = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
  details: null,
};

module.exports = {
  default: {
    fetch: jest.fn(() => Promise.resolve(state)),
    addEventListener: jest.fn(() => () => undefined),
    configure: jest.fn(),
    refresh: jest.fn(() => Promise.resolve(state)),
  },
  fetch: jest.fn(() => Promise.resolve(state)),
  addEventListener: jest.fn(() => () => undefined),
  configure: jest.fn(),
  refresh: jest.fn(() => Promise.resolve(state)),
  NetInfoStateType: {
    unknown: 'unknown',
    none: 'none',
    wifi: 'wifi',
    cellular: 'cellular',
  },
};
