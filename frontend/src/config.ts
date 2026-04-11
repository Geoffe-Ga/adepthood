const DEV_DEFAULT_URL = 'http://localhost:8000';

export function validateApiBaseUrl(url: string, isDev: boolean): string {
  if (!isDev && !url.startsWith('https://')) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL must be set to an HTTPS URL in production builds. ' +
        `Received: "${url || '(empty)'}"`,
    );
  }
  return url;
}

const rawUrl = process.env.EXPO_PUBLIC_API_BASE_URL || (__DEV__ ? DEV_DEFAULT_URL : '');

export const API_BASE_URL = validateApiBaseUrl(rawUrl, __DEV__);
