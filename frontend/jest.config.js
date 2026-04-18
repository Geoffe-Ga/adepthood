/** @type {import('jest').Config} */
module.exports = {
  // Use the react-native preset to avoid requiring Expo-specific tooling
  preset: 'react-native',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect'],
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@react-native-async-storage/async-storage$': '<rootDir>/src/__mocks__/async-storage.js',
    '^expo-secure-store$': '<rootDir>/src/__mocks__/expo-secure-store.js',
    '^expo-av$': '<rootDir>/src/__mocks__/expo-av.js',
    '^expo-keep-awake$': '<rootDir>/src/__mocks__/expo-keep-awake.js',
    '^@react-native-community/netinfo$': '<rootDir>/src/__mocks__/netinfo.js',
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
