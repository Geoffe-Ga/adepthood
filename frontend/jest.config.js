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
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '^expo-secure-store$': '<rootDir>/src/__mocks__/expo-secure-store.js',
    '^expo-av$': '<rootDir>/src/__mocks__/expo-av.js',
    '^expo-keep-awake$': '<rootDir>/src/__mocks__/expo-keep-awake.js',
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
};
