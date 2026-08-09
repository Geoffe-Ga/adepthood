// Pin timezone so date-math tests are hermetic; Node latches TZ at first Date use.
process.env.TZ = 'UTC';

/** @type {import('jest').Config} */
module.exports = {
  // React Native >=0.85 removed the bundled 'react-native' preset; it now ships
  // as its own package. Without this swap every suite fails to *start*, which
  // reads as catastrophic breakage rather than a missing dependency.
  preset: '@react-native/jest-preset',
  // BUG-FE-TEST-001: ``clearMocks: true`` zeroes mock call counts
  // between tests so a ``mockFetch.mockReturnValueOnce(...)`` queue from
  // one ``it()`` cannot leak into the next.  ``resetMocks: true`` is
  // strictly stronger -- it ALSO restores the implementation -- but
  // enabling it project-wide today exposes ~90 tests that quietly
  // depend on a module-level mock implementation surviving across
  // ``it()`` blocks (e.g. ``jest.mock('foo', () => ({...}))``).  We
  // ship the safe half here; ``resetMocks`` is tracked as a follow-up
  // that audits each call site rather than turning the suite red.
  clearMocks: true,
  // BUG-FE-TEST-002 deferred: ``testEnvironment: 'jsdom'`` is the right
  // fit for component tests that touch ``window`` / ``document``, but a
  // project-wide flip risks breaking unit tests that expect the node
  // global.  Tracked for a follow-up that opts component test files
  // into ``@jest-environment jsdom`` per-file via the docblock pragma.
  testEnvironment: 'node',
  setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect', '<rootDir>/jest.setup.js'],
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@react-native-async-storage/async-storage$': '<rootDir>/src/__mocks__/async-storage.js',
    '^expo-secure-store$': '<rootDir>/src/__mocks__/expo-secure-store.js',
    '^expo-apple-authentication$': '<rootDir>/src/__mocks__/expo-apple-authentication.js',
    '^expo-auth-session/providers/google$': '<rootDir>/src/__mocks__/expo-auth-session-google.js',
    '^expo-web-browser$': '<rootDir>/src/__mocks__/expo-web-browser.js',
    '^expo-av$': '<rootDir>/src/__mocks__/expo-av.js',
    '^expo-file-system$': '<rootDir>/src/__mocks__/expo-file-system.js',
    '^expo-haptics$': '<rootDir>/src/__mocks__/expo-haptics.js',
    '^expo-image-manipulator$': '<rootDir>/src/__mocks__/expo-image-manipulator.js',
    '^expo-image-picker$': '<rootDir>/src/__mocks__/expo-image-picker.js',
    '^expo-keep-awake$': '<rootDir>/src/__mocks__/expo-keep-awake.js',
    '^expo-notifications$': '<rootDir>/src/__mocks__/expo-notifications.js',
    '^@react-native-community/netinfo$': '<rootDir>/src/__mocks__/netinfo.js',
    '^rn-emoji-keyboard$': '<rootDir>/src/__mocks__/rn-emoji-keyboard.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(' +
      'react-native|' +
      '@react-native|' +
      'react-clone-referenced-element|' +
      '@react-navigation|' +
      'expo(nent)?|' +
      '@expo(nent)?/.*|' +
      '@unimodules/.*|' +
      'unimodules|' +
      'sentry-expo|' +
      'native-base|' +
      'react-native-markdown-display|' +
      'uuid' +
      ')/)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],
  // Enforce minimum 90% coverage on all metrics — ported from
  // adepthood-typescript-linters. Run `npm test -- --coverage` to see
  // the full report; CI will fail if any metric drops below threshold.
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
};
