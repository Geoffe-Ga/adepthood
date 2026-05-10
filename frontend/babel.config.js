/* eslint-disable */
// ``react-native-reanimated/plugin`` MUST be the last plugin and is needed
// in BOTH dev (Metro ``NODE_ENV=development``) and prod builds — without
// it ``useAnimatedStyle`` / worklets throw at runtime.  The earlier
// ``env.production``-only scope (PR #298 review fix) accidentally also
// stripped the plugin from Metro dev, so we keep the plugin unconditional
// here and mock the module in Jest setup instead (see
// ``__mocks__/react-native-reanimated.js`` + the ``moduleNameMapper`` in
// ``jest.config.js``).
module.exports = {
  presets: ['babel-preset-expo'],
  plugins: ['react-native-reanimated/plugin'],
};
