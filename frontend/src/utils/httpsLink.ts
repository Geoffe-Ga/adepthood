/**
 * A configured door out of the app, resolved to something safe to open.
 *
 * Shared by every link whose address is deployment configuration rather than a
 * literal (the Digital Sangha invite, the credit pack page), so they fail
 * closed by one rule.
 */

/** The only scheme a door out of the app is allowed to use. */
const HTTPS_PREFIX = 'https://';

/**
 * Resolve a configured link, or ``null`` when there is nothing safe to open.
 *
 * Whitespace is trimmed because an env var reaches a build through shells and
 * CI secret stores that add it. Everything that is not a non-empty ``https``
 * URL resolves to ``null``: ``http`` is downgrade-prone and a custom scheme is
 * an app-hijack vector, and neither is worth rendering a link for.
 */
export function httpsLinkOrNull(configured: string): string | null {
  const trimmed = configured.trim();
  if (!trimmed.startsWith(HTTPS_PREFIX) || trimmed.length === HTTPS_PREFIX.length) {
    return null;
  }
  return trimmed;
}
