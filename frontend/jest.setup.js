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

// ``react-native-webview`` ships native code that Jest cannot bundle.
// Returning a thin stub that captures props lets tests assert what HTML
// would have been rendered without spinning up an actual WebView.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    WebView: (props) =>
      React.createElement(View, {
        testID: props.testID ?? 'webview',
        accessibilityLabel: props.accessibilityLabel,
        'data-source-html': props.source?.html,
        'data-source-uri': props.source?.uri,
      }),
    default: (props) =>
      React.createElement(View, {
        testID: props.testID ?? 'webview',
        accessibilityLabel: props.accessibilityLabel,
        'data-source-html': props.source?.html,
        'data-source-uri': props.source?.uri,
      }),
  };
});
