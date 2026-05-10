/* eslint-disable */
// BUG-FE-TEST-003: ``react-native-reanimated/plugin`` MUST be the last
// plugin and only loads in production.  In test (jest) the plugin's
// worklet transform fights with babel-preset-expo's CommonJS output and
// produces opaque "Reanimated 2 failed to create a worklet" runtime
// errors that obscure the real test failure.  Scoping the plugin to
// ``env.production`` keeps animations working in release builds while
// letting the Jest pipeline run the same transforms it always has.
module.exports = {
  presets: ['babel-preset-expo'],
  env: {
    production: {
      plugins: ['react-native-reanimated/plugin'],
    },
  },
};
