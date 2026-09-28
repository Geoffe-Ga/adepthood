/* eslint-disable */
// Contain a test abandoned mid real-timer `act()`, so one timeout costs
// exactly one failure. This must stay at the very top of the file.
//
// The fake-timer containment further down only helps when the abandoned test
// was waiting on a fake timer it can drain. A test starved past `testTimeout`
// by CPU load is usually parked on *real* work instead: an
// `await act(async () => ...)` whose body is awaiting something that will not
// settle before jest-circus gives up on it. The consequence is identical --
// React's act scope depth stays above zero (it is only decremented in the
// continuation of the promise the callback returned), every later `act()` in
// the file queues its render work instead of committing it, and the
// neighbouring tests fail with `Can't access .root on unmounted test renderer`
// -- but there is no fake clock to run.
//
// So every async act scope is raced, *inside* the callback handed to React's
// real `act`, against a rejection this file owns. After each test, any scope
// still open is one its test abandoned; rejecting it makes React's rejection
// path run `popActScope`, which restores the depth before the next test
// starts. The race has to sit inside the callback: racing the thenable `act`
// returns from outside would leave React awaiting the original, never-settling
// promise, and `popActScope` would never run.
//
// Reject, never resolve. Resolving would *resume* the abandoned test body
// after its `await act(...)`, and its remaining renders, presses and mock
// calls would then run inside whichever test is live -- after `clearMocks` has
// reset that test's call counts -- which is the phantom-failure class again
// under another name. A rejection unwinds the abandoned body instead, into a
// test jest-circus has already reported.
//
// Both React Native Testing Library (`build/act.js`) and react-test-renderer
// capture `React.act` when they load, so the wrapper is installed here, before
// anything else in this file can require either of them. A synchronous act is
// passed through untouched, so it stays synchronous.
//
// `__tests__/timeoutCascade.test.ts` guards this with a real-timer fixture.
const React = require('react');
// Node's `timers` module is never faked by Jest, so this yields one real
// macrotask even inside a fake-timer test.
const { setImmediate: realSetImmediate } = require('timers');

class AbandonedTestError extends Error {
  constructor() {
    super('act() scope abandoned: its test ended (usually a timeout) before the scope settled');
    this.name = 'AbandonedTestError';
  }
}

const openActScopes = new Set();
const realAct = React.act;
const isThenable = (value) =>
  value !== null && typeof value === 'object' && typeof value.then === 'function';

React.act = (callback) =>
  realAct(() => {
    const result = callback();
    if (!isThenable(result)) {
      return result;
    }
    // A hand-rolled thenable rather than `Promise.race(...)`: it forwards the
    // callback's settlement to React in the same microtask the callback's own
    // promise would have, so a test that happens to lean on act's exact
    // microtask timing (an `await expect(act(...)).resolves`, say, which does
    // not really await the thenable) sees no difference.
    return {
      then(onFulfilled, onRejected) {
        let settled = false;
        const settleOnce = (handler) => (value) => {
          if (settled) {
            return;
          }
          settled = true;
          openActScopes.delete(abandon);
          handler(value);
        };
        const abandon = settleOnce(onRejected);
        openActScopes.add(abandon);
        return result.then(settleOnce(onFulfilled), abandon);
      },
    };
  });

afterEach(async () => {
  if (openActScopes.size === 0) {
    return;
  }
  for (const abandon of openActScopes) {
    abandon(new AbandonedTestError());
  }
  openActScopes.clear();
  // Let React's rejection continuation (`popActScope`) run before the next
  // test renders anything.
  await new Promise((resolve) => realSetImmediate(resolve));
});

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
// Contain a test-timeout cascade, so one timeout costs exactly one failure.
//
// When jest-circus times a test out it abandons the test function wherever it
// is parked. A `try { ... } finally { jest.useRealTimers(); }` around a
// fake-timer block therefore never reaches its `finally`, and whatever promise
// the body was awaiting stays pending forever.
//
// That is worse than an untidy teardown. React's `act()` decrements its scope
// depth only inside that pending promise's continuation (`popActScope`, in
// react/cjs/react.development.js), and it flushes its queue only when the
// depth it entered at was zero. So an abandoned `await act(async () => ...)`
// leaves the depth permanently above zero, and every later `act()` in that
// file *queues* render work instead of committing it. The following tests then
// render an empty tree, and React Native Testing Library reports
// `Can't access .root on unmounted test renderer` against a component that is
// perfectly fine. One genuine timeout was costing four failures this way, and
// the three phantom ones name innocent tests -- which is what sends an
// investigation to the wrong file.
//
// Running the pending fake timers lets the abandoned continuation settle,
// which runs `popActScope` and restores the depth before the next test starts.
// `runOnlyPendingTimers` and not `runAllTimers` on purpose: a timer that
// reschedules itself -- a JS-driven `Animated` loop, say -- would spin forever
// under the latter.
//
// The fake-timer check is a property sniff rather than a `try`/`catch` around
// `runOnlyPendingTimers`, because catching here would also swallow a genuine
// error thrown by a timer callback and turn a real failure into silence. If a
// future Jest stops tagging the installed `setTimeout`, this degrades to a
// no-op rather than to a lie, and `__tests__/timeoutCascade.test.ts` fails.
// Note what this deliberately does NOT do: switch back to real timers. A
// suite-scoped fake clock installed in `beforeAll` (see
// `__tests__/DatePicker.test.tsx`, which pins the system time to 2025) is a
// legitimate pattern here, and restoring real timers after every test would
// silently hand the second test onward the real clock — turning a date
// assertion into a failure that only appears next calendar year. Draining the
// pending timers is enough to unstick React, and leaves the clock where the
// suite put it.
const usingFakeTimers = () => Object.prototype.hasOwnProperty.call(setTimeout, 'clock');

afterEach(() => {
  if (usingFakeTimers()) {
    jest.runOnlyPendingTimers();
  }
});

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

jest.mock('react-test-renderer', () => {
  const actual = jest.requireActual('react-test-renderer');
  const create = (element, options) => {
    let renderer;
    actual.act(() => {
      renderer = actual.create(element, options);
    });
    return renderer;
  };
  return { ...actual, create };
});
