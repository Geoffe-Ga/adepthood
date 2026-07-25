import { Linking } from 'react-native';

/**
 * Only ``https://`` survives the allowlist. ``http`` is downgrade-prone,
 * custom schemes are an app-hijack vector, and ``javascript:`` is straight
 * code execution — none of them belong behind a marketing CTA.
 */
const HTTPS_PREFIX = 'https://';

/** Bare copy for the log; the URL itself is deliberately not echoed. */
const REFUSED_MESSAGE = 'openExternalUrl refused a URL that is not https';
const FAILED_MESSAGE = 'openExternalUrl could not hand the URL to the platform';

function isOpenableHttpsUrl(url: string): boolean {
  return url.startsWith(HTTPS_PREFIX) && url.length > HTTPS_PREFIX.length;
}

/**
 * Hand an external ``https`` URL to the platform browser.
 *
 * Resolves ``true`` when the platform accepted the URL and ``false`` for every
 * failure mode — a refused scheme, a rejected promise, or a synchronous throw
 * from ``Linking``. It never rejects, so callers can fire it from a press
 * handler without a try/catch and without risking an unhandled rejection. This
 * also matters on simulators, which routinely have no browser to hand a URL
 * to: that failure should not read as a crash any more than a real device's
 * would.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isOpenableHttpsUrl(url)) {
    console.warn(REFUSED_MESSAGE);
    return false;
  }
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    // The platform's rejection embeds the URL it could not open, so the error
    // itself is dropped rather than logged: this helper is caller-agnostic, and
    // a URL it is handed may one day carry a token or a key.
    console.warn(FAILED_MESSAGE);
    return false;
  }
}
