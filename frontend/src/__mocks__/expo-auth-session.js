/* eslint-env jest */
/* global jest */
// ``expo-auth-session`` ships untranspiled ESM and is not covered by the
// preset's transformIgnorePatterns allowlist, so Jest cannot parse the real
// module. Only the code trade is imported from the root package; tests that
// care about it override this with jest.mock.
module.exports = {
  exchangeCodeAsync: jest.fn(() => Promise.reject(new Error('exchangeCodeAsync is not mocked'))),
};
