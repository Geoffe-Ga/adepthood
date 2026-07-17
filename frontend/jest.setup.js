/* eslint-disable */
// Jest setup: mock ``react-native-reanimated`` so its worklet plugin does
// not run in the test transform (PR #298 review fix).  Earlier we tried
// scoping the babel plugin to ``env.production``, but that also stripped
// the plugin from Metro's ``NODE_ENV=development`` builds and broke
// animations in local dev.  Mocking the module here is the upstream-
// recommended pattern and only affects Jest.
//
// Reanimated ships a hand-rolled mock with the right named exports
// (``useAnimatedStyle``, ``createAnimatedComponent``, etc.) so screens
// that import the library at all do not need per-file mocks.
jest.mock('react-native-reanimated', () => {
  // ``react-native-reanimated/mock`` exists in v3+; fall back to a
  // permissive object proxy when the bundled mock is unavailable so the
  // suite still loads on minor reanimated upgrades.
  try {
    const reanimatedMock = require('react-native-reanimated/mock');
    // The bundled mock leaves the worklet runtime as a no-op, which is
    // exactly what tests need.
    reanimatedMock.default = reanimatedMock.default ?? {};
    reanimatedMock.default.call = reanimatedMock.default.call ?? (() => {});
    return reanimatedMock;
  } catch (e) {
    return new Proxy(
      {},
      {
        get: () => () => undefined,
      },
    );
  }
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const defaultInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  const defaultFrame = { x: 0, y: 0, width: 390, height: 844 };
  const SafeAreaInsetsContext = React.createContext(null);
  const SafeAreaFrameContext = React.createContext(defaultFrame);
  const SafeAreaProvider = ({ children }) => React.createElement(React.Fragment, null, children);
  const SafeAreaView = ({ children, ...props }) => React.createElement(View, props, children);
  return {
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    initialWindowMetrics: { insets: defaultInsets, frame: defaultFrame },
    useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext) ?? defaultInsets,
    useSafeAreaFrame: () => React.useContext(SafeAreaFrameContext) ?? defaultFrame,
    SafeAreaProvider,
    SafeAreaView,
  };
});

// Cancel animation frames that outlive the test that scheduled them.
//
// The React Native Jest preset polyfills ``requestAnimationFrame`` as
// ``setTimeout(cb, 0)`` (see react-native/jest/setup.js). A JS-driven
// ``Animated`` timing (``useNativeDriver: false``) keeps requesting frames
// until it finishes, so a component still mounted when its test ends leaves a
// frame queued. That frame fires on the next tick -- after Jest has torn the
// environment down -- and throws ``ReferenceError: You are trying to access a
// property or method of the Jest environment after it has been torn down``,
// which fails the whole suite even though every ``it()`` passed. Because Jest
// attributes the error to whichever suite happens to be tearing down at that
// instant, it lands on a different, innocent suite on almost every run, making
// the failure a cross-suite flake no per-suite cleanup can reliably contain.
//
// Tracking every outstanding frame and cancelling the stragglers after each
// test bounds that escaping work at its scheduler: anything still pending when
// a test finishes was, by definition, never awaited, so cancelling it changes
// no in-test behavior while making the leak structurally impossible.
const outstandingAnimationFrames = new Set();
const scheduleAnimationFrame = global.requestAnimationFrame;
const clearAnimationFrame = global.cancelAnimationFrame;

global.requestAnimationFrame = (callback) => {
  const handle = scheduleAnimationFrame((time) => {
    outstandingAnimationFrames.delete(handle);
    callback(time);
  });
  outstandingAnimationFrames.add(handle);
  return handle;
};

global.cancelAnimationFrame = (handle) => {
  outstandingAnimationFrames.delete(handle);
  return clearAnimationFrame(handle);
};

afterEach(() => {
  for (const handle of outstandingAnimationFrames) {
    clearAnimationFrame(handle);
  }
  outstandingAnimationFrames.clear();
});
