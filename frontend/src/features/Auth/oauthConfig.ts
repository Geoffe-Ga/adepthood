import { Platform } from 'react-native';

import { resolveEnv } from '@/config';

/**
 * Google OAuth client IDs, one per platform, empty when the build was not
 * configured for that platform.
 *
 * Each is read through {@link resolveEnv} with a statically-keyed
 * ``process.env`` member expression, which is the only form babel-preset-expo
 * inlines into a production bundle.
 */
export const googleClientIds: { ios: string; android: string; web: string } = {
  ios: resolveEnv(
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
    'EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS',
    '',
  ),
  android: resolveEnv(
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID,
    'EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID',
    '',
  ),
  web: resolveEnv(
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB,
    'EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB',
    '',
  ),
};

/**
 * Client ID that would actually be used on this device. Anything that is
 * neither iOS nor Android (web, and desktop targets like macOS) runs the
 * browser redirect flow, so it resolves to the web ID.
 */
function clientIdForPlatform(): string {
  if (Platform.OS === 'ios') return googleClientIds.ios;
  if (Platform.OS === 'android') return googleClientIds.android;
  return googleClientIds.web;
}

/**
 * Whether "Continue with Google" should be offered at all — the safe-rollout
 * switch. An unset (or whitespace-only, which ``promptAsync`` would choke on)
 * client ID for this platform hides the button rather than shipping a control
 * that fails the moment it is tapped.
 */
export function isGoogleAuthConfigured(): boolean {
  return clientIdForPlatform().trim().length > 0;
}
