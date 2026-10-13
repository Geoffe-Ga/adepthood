/**
 * Render nginx.conf's Content-Security-Policy for one web build (ADR 0009
 * phase (b), #3067).
 *
 *   node web-hardening/csp.js <template> <output>
 *
 * The enforced policy narrows `connect-src` to the origins this build actually
 * talks to. Two of them are only known at build time, from the same
 * `EXPO_PUBLIC_*` values `expo export` bakes into the bundle, so they cannot be
 * written into the checked-in conf:
 *
 * - the API origin, from `EXPO_PUBLIC_API_BASE_URL` (required, https), and
 * - the Sentry ingest origin, from `EXPO_PUBLIC_SENTRY_DSN` (only when set).
 *
 * The template carries `__BUILD_CONNECT_ORIGINS__` where they go. Rendering
 * replaces every occurrence and writes `<output>`; it refuses (exit 1, nothing
 * written) when there is no https API origin, when a DSN is set but is not an
 * https URL, or when the template has no placeholder. An unrendered conf fails
 * closed on its own: browsers drop the token as an invalid source, so the API
 * is refused rather than every https host being allowed. Usage errors exit 2.
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

const TOKEN = '__BUILD_CONNECT_ORIGINS__';
const API_ENV = 'EXPO_PUBLIC_API_BASE_URL';
const SENTRY_ENV = 'EXPO_PUBLIC_SENTRY_DSN';
const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_USAGE = 2;

/**
 * The https origin of `value`, or a reason it has none.
 *
 * @param {string} name - The env var it came from, for the message.
 * @param {string} value - A URL.
 * @returns {{ origin: string } | { problem: string }}
 */
function httpsOrigin(name, value) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { problem: `${name} is not a URL: "${value}"` };
  }
  if (url.protocol !== 'https:') return { problem: `${name} must be an https URL: "${value}"` };
  return { origin: url.origin };
}

/**
 * The build-time connect-src origins, in policy order.
 *
 * @param {Record<string, string | undefined>} env - The build environment.
 * @returns {{ origins: string[] } | { problem: string }}
 */
function connectOrigins(env) {
  const api = (env[API_ENV] ?? '').trim();
  if (api === '') return { problem: `${API_ENV} is unset; the policy has no API origin` };
  const apiOrigin = httpsOrigin(API_ENV, api);
  if (!('origin' in apiOrigin)) return apiOrigin;
  const origins = [apiOrigin.origin];
  const dsn = (env[SENTRY_ENV] ?? '').trim();
  if (dsn !== '') {
    const sentryOrigin = httpsOrigin(SENTRY_ENV, dsn);
    if (!('origin' in sentryOrigin)) return sentryOrigin;
    if (!origins.includes(sentryOrigin.origin)) origins.push(sentryOrigin.origin);
  }
  return { origins };
}

/**
 * @param {string} template - nginx.conf as checked in.
 * @param {Record<string, string | undefined>} env - The build environment.
 * @returns {{ conf: string } | { problem: string }}
 */
function render(template, env) {
  if (!template.includes(TOKEN)) return { problem: `the template has no ${TOKEN} to render` };
  const resolved = connectOrigins(env);
  if (!('origins' in resolved)) return resolved;
  return { conf: template.split(TOKEN).join(resolved.origins.join(' ')) };
}

/**
 * @param {string[]} argv - `[template, output]`.
 * @param {Record<string, string | undefined>} env - The build environment.
 * @returns {number} The process exit code.
 */
function main(argv, env) {
  const [template, output] = argv;
  if (template === undefined || output === undefined || !existsSync(template)) {
    console.error('usage: node web-hardening/csp.js <nginx.conf template> <output>');
    return EXIT_USAGE;
  }
  const rendered = render(readFileSync(template, 'utf8'), env);
  if (!('conf' in rendered)) {
    console.error(`csp: ${rendered.problem}`);
    return EXIT_VIOLATION;
  }
  writeFileSync(output, rendered.conf, 'utf8');
  console.log(`csp: rendered ${output}`);
  return EXIT_OK;
}

module.exports = { TOKEN, connectOrigins, main, render };

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);
