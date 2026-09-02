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
  setupFilesAfterEnv: [
    '@testing-library/jest-native/extend-expect',
    '<rootDir>/jest.setup.js',
    // Runs on every suite, not just the cross-boundary ones: its job is to
    // catch a suite that reads backend source without the marker that makes it
    // discoverable by scripts/frontend/cross-boundary-drift.sh.
    '<rootDir>/jest.setup.crossBoundary.js',
  ],
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  // `__tests__/fixtures/` holds suites that are *supposed* to fail: they stage a
  // runner-level condition (a test abandoned by a timeout) that no in-process
  // assertion can produce. `__tests__/timeoutCascade.test.ts` runs them in a
  // child Jest and asserts on the result, re-including them with an explicit
  // `--testPathIgnorePatterns`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/fixtures/'],
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@react-native-async-storage/async-storage$': '<rootDir>/src/__mocks__/async-storage.js',
    '^expo-secure-store$': '<rootDir>/src/__mocks__/expo-secure-store.js',
    '^expo-apple-authentication$': '<rootDir>/src/__mocks__/expo-apple-authentication.js',
    '^expo-auth-session/providers/google$': '<rootDir>/src/__mocks__/expo-auth-session-google.js',
    '^expo-web-browser$': '<rootDir>/src/__mocks__/expo-web-browser.js',
    '^expo-document-picker$': '<rootDir>/src/__mocks__/expo-document-picker.js',
    '^expo-file-system$': '<rootDir>/src/__mocks__/expo-file-system.js',
    '^expo-haptics$': '<rootDir>/src/__mocks__/expo-haptics.js',
    '^expo-screen-orientation$': '<rootDir>/src/__mocks__/expo-screen-orientation.js',
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
      // chart-kit 7 ships ESM where 6 shipped CJS, so the real module now needs
      // transforming. Nothing caught this for a while because every StatsModal
      // test mocked the library away; StatsModal.realCharts.test.tsx renders it.
      'react-native-chart-kit|' +
      'uuid' +
      ')/)',
  ],
  // Bound what a worker may hold before Jest recycles it, so the suite's
  // footprint stops scaling with how long it runs.
  //
  // Nothing bounded worker memory before this. Measured on a 10-core box at
  // 6258 tests, no coverage, peak summed jest-worker RSS / wall clock:
  //
  //   9 workers, unbounded (the default)   6.36 GB   17.4s
  //   9 workers, 512MB                     4.98 GB   19.2s   -22% for +10%
  //   9 workers, 256MB                     3.92 GB   24.1s   -38% for +39%
  //   --maxWorkers=50% (5), unbounded      6.12 GB   24.3s    -4% for +40%
  //   --maxWorkers=3, unbounded            4.50 GB   37.8s   -29% for +117%
  //   --maxWorkers=3 + 512MB               2.24 GB   40.9s    -50% vs the line above
  //
  // Hence 512MB, and hence no `maxWorkers` here. Capping workers is the weaker
  // lever twice over: it buys 4% for a 40% slowdown, and per-worker RSS *rises*
  // as the count falls (706 MB each at 9 workers, 1.50 GB each at 3) because
  // each surviving worker then holds more suites' transform cache. It moves
  // memory rather than removing it, and on CI — a 4-core runner, so already
  // effectively 3 — it would cut an already-small pool to 2.
  //
  // The last row is the CI-shaped case, and it is why this is unconditional
  // rather than environment-aware: at 3 workers the bound costs 8% wall clock
  // and halves memory.
  //
  // Summed RSS over-counts shared copy-on-write pages, so read it as an upper
  // bound rather than a footprint. The independent OS reading moves the same
  // way: memory available at peak (vm_stat free + inactive + speculative) rose
  // from 4.36 GB unbounded to 5.83 GB at 512MB.
  workerIdleMemoryLimit: '512MB',
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
