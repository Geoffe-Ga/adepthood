/**
 * The vocabulary bans "Agents that may read your vault" is held to (#3534).
 *
 * Shared by the two guards that sweep words a person reads in that section:
 * ``agentsCopy.test.ts`` over the frontend's own copy, and
 * ``agentActivityDrift.test.ts`` over the labels the activity route writes on
 * the server (#3535), so both halves of one list obey one rule.
 */

/**
 * Hosts, transports, credentials and routing (the vault deck's ban), plus the
 * authorization vocabulary an agent arrives through.
 */
export const BANNED_TECHNICAL =
  /\b(host|hostname|url|uri|endpoint|api key|apikey|bearer|token|credential|mcp|https?|port|protocol|routing|route|server|sync|tenant|node|instance|oauth|scope|client|grant|revoke|refresh|redirect|jwt)\b/iu;

/** Loss and obligation framing. */
export const BANNED_PRESSURE =
  /\b(backup|back up|safeguard|protect|secure your|lose|lost|losing|at risk|danger|failure|required|must|need to|should)\b/iu;
