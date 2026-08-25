// Real-wire end-to-end lane.
//
// Everything on the request path is real: the production API client in
// `src/api/index.ts`, its Zod response validation, its retry/refresh loop, a
// real `fetch` over a real socket, and a live FastAPI server on ephemeral
// Postgres. Nothing here is mocked.
//
// The lane is deliberately unreachable from `npx jest`: the default config's
// `roots` are `src` and `__tests__`, so a top-level `e2e/` folder is invisible
// to it. That isolation is what lets this project drop the unit suite's expo
// `moduleNameMapper` shims and its 90% coverage thresholds without weakening
// either of them for the suite that actually needs them.

/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  roots: ['<rootDir>/e2e'],
  testMatch: ['<rootDir>/e2e/**/*.e2e.test.ts'],
  testEnvironment: 'node',
  // One server, one database, journeys that read back what they wrote.
  maxWorkers: 1,
  // babel-preset-expo inlines `process.env.EXPO_PUBLIC_API_BASE_URL` at
  // transform time, so a warm transform cache would bake a previous run's
  // ephemeral port into the compiled `@/config`.
  cache: false,
  // `src/config.ts` reads `__DEV__`, which only the react-native preset defines.
  globals: { __DEV__: true },
  // The alias and nothing else: no expo module mocks, no fetch shim.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // SDK 57's babel-preset-expo rewrites `process.env` reads into an import of
  // `expo/virtual/env`, which ships as ESM. Jest's default here skips all of
  // node_modules, so that file would reach the runtime untransformed and throw
  // on its `export`. Un-ignore expo's virtual modules and nothing else — the
  // point of this lane is that the rest of node_modules stays real.
  transformIgnorePatterns: ['node_modules/(?!expo/virtual/)'],
  globalSetup: '<rootDir>/e2e/globalSetup.ts',
  globalTeardown: '<rootDir>/e2e/globalTeardown.ts',
  setupFiles: ['<rootDir>/e2e/setupEnv.ts'],
  testTimeout: 60000,
};
