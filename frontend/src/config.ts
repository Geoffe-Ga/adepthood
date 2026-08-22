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

// Gumroad is where the course is bought and where license-key help lives.
// Both are public marketing pages with safe defaults, so — unlike
// ``API_BASE_URL`` — a missing override is not a misconfiguration and must
// never contribute to ``CONFIG_ERROR``.
const DEFAULT_GUMROAD_PRODUCT_URL = 'https://adepthood.gumroad.com/l/aptitude';
const DEFAULT_GUMROAD_HELP_URL = 'https://help.gumroad.com/article/76-license-keys';

/**
 * Resolve an ``EXPO_PUBLIC_*`` override, checking both routes the value can
 * take.
 *
 * ``inlined`` is the result of a *static* ``process.env.EXPO_PUBLIC_…``
 * reference at the call site: babel-preset-expo rewrites that expression to the
 * build-time literal, which is the only way an override reaches a production
 * bundle. ``name`` covers the runtime route, which Metro populates during
 * development. The computed lookup is deliberate — the inliner only rewrites
 * statically-keyed member expressions, so this one survives as a real read.
 *
 * Call it with both halves of the same variable, always writing the first
 * argument as a literal member expression:
 * ``resolveEnv(process.env.EXPO_PUBLIC_FOO, 'EXPO_PUBLIC_FOO', 'default')``.
 */
export function resolveEnv(inlined: string | undefined, name: string, fallback: string): string {
  return inlined || process.env[name] || fallback;
}

/** Product page the pre-auth Get Started CTA opens. */
export const GUMROAD_PRODUCT_URL = resolveEnv(
  process.env.EXPO_PUBLIC_GUMROAD_PRODUCT_URL,
  'EXPO_PUBLIC_GUMROAD_PRODUCT_URL',
  DEFAULT_GUMROAD_PRODUCT_URL,
);

/** "Where's my key?" help article linked from the signup form. */
export const GUMROAD_HELP_URL = resolveEnv(
  process.env.EXPO_PUBLIC_GUMROAD_HELP_URL,
  'EXPO_PUBLIC_GUMROAD_HELP_URL',
  DEFAULT_GUMROAD_HELP_URL,
);

/**
 * Permanent Discord invite for the Digital Sangha.
 *
 * Unlike the Gumroad links this has no default, and its absence is not a
 * misconfiguration: the server and its never-expiring invite belong to the
 * owner, and a placeholder here would ship a dead link inside a store binary
 * that cannot be patched. Empty means the app does not mention the Sangha at
 * all, which is an absent invitation rather than a broken one — so, like the
 * Gumroad links and unlike ``API_BASE_URL``, it never contributes to
 * ``CONFIG_ERROR``.
 */
export const SANGHA_INVITE_URL = resolveEnv(
  process.env.EXPO_PUBLIC_SANGHA_INVITE_URL,
  'EXPO_PUBLIC_SANGHA_INVITE_URL',
  '',
);
