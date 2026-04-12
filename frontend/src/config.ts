const DEV_DEFAULT_URL = 'http://localhost:8000';

export function validateApiBaseUrl(url: string, isDev: boolean): string {
  if (!isDev && !url.startsWith('https://')) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL must be set to an HTTPS URL in production builds. ' +
        `Received: "${url || '(empty)'}"`,
    );
  }
  // Strip trailing slashes so `${API_BASE_URL}${path}` — where paths always
  // start with "/" — can't produce "//auth/signup" (which FastAPI 404s).
  return url.replace(/\/+$/, '');
}

const rawUrl = process.env.EXPO_PUBLIC_API_BASE_URL || (__DEV__ ? DEV_DEFAULT_URL : '');

/**
 * Configuration error captured at module load, if any.
 *
 * We deliberately do NOT throw at top-level import: a top-level throw happens
 * before React can mount, producing a silent blank screen in browsers where
 * dev tools aren't readily available (e.g. iOS Safari). Instead, App.tsx reads
 * this value and renders a visible error screen when set.
 */
export let CONFIG_ERROR: string | null = null;

function resolveApiBaseUrl(): string {
  try {
    return validateApiBaseUrl(rawUrl, __DEV__);
  } catch (err) {
    CONFIG_ERROR = err instanceof Error ? err.message : String(err);
    return rawUrl;
  }
}

export const API_BASE_URL = resolveApiBaseUrl();
