import { BUILD_PATTERN, FEEDBACK_BUILD_MAX_LENGTH } from './feedbackBounds';

/**
 * The build a report says it came from when nothing better is configured.
 *
 * The app has no `expo-constants` or `expo-application` to ask, so the honest
 * floor is the version `app.json` ships (`expo.version`); `appBuild.test.ts`
 * pins the two together so a version bump cannot leave this behind.
 */
export const APP_BUILD_FALLBACK = '1.0.0';

/**
 * Resolve `context.app_build`.
 *
 * The release name a deployment gives Sentry (`EXPO_PUBLIC_SENTRY_RELEASE`) is
 * the most specific build identifier the bundle carries, so it wins -- but only
 * when it already fits the server's `BUILD_PATTERN` and length. A release named
 * `adepthood@1.4.2` would be a 422, so it falls back rather than being mangled
 * into something that merely passes.
 *
 * `process.env.EXPO_PUBLIC_SENTRY_RELEASE` is referenced literally because Expo
 * inlines `EXPO_PUBLIC_*` values only at a static member access.
 */
export function resolveAppBuild(
  configured: string | undefined = process.env.EXPO_PUBLIC_SENTRY_RELEASE,
): string {
  if (
    configured !== undefined &&
    configured.length <= FEEDBACK_BUILD_MAX_LENGTH &&
    BUILD_PATTERN.test(configured)
  ) {
    return configured;
  }
  return APP_BUILD_FALLBACK;
}
