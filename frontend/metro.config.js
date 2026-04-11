// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Enable Node package exports resolution so Metro can resolve subpath imports
// like "styleq/transform-localize-style" used by react-native-web.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
