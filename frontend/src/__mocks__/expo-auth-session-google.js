/* eslint-env jest */
/* global jest */
// ``expo-auth-session`` ships untranspiled ESM and is not covered by the
// preset's transformIgnorePatterns allowlist, so Jest cannot parse the real
// module. Tests that care about the flow override this with jest.mock.
module.exports = {
  useAuthRequest: jest.fn(() => [null, null, jest.fn(() => Promise.resolve({ type: 'dismiss' }))]),
};
