/**
 * Turning one connected-agent row from ``GET /vault/agents`` into what a person
 * reads (#3534): a name, what it may do, where it signs in, and when it was
 * last used.
 *
 * Pure functions over the row, kept out of the component so each rule is
 * tested on its own and so the activity list that renders beneath the agents
 * (#3535) says "5 minutes ago" the same way, through ``whenPhrase``. Every sentence comes from
 * ``agentsCopy``; nothing here writes copy of its own beyond joining it to a
 * number or a host.
 */
import {
  AGENTS_LAST_USED,
  AGENTS_NOT_USED_YET,
  AGENTS_ON_THIS_COMPUTER,
  AGENTS_SIGNS_IN_THROUGH,
  AGENTS_UNNAMED,
  AGENT_GRANT_PHRASES,
} from './agentsCopy';

import type { ConnectedAgent } from '@/api';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
/** Past this many days a count stops meaning much and a date says it better. */
const DAYS_BEFORE_A_DATE = 30;

/**
 * The hosts a program on the person's own computer returns them to. The same
 * three the server treats as loopback for a redirect (RFC 8252).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** The name an agent gave itself, or the consent page's words for one that gave none. */
export function agentDisplayName(agent: Pick<ConnectedAgent, 'name'>): string {
  const name = agent.name?.trim();
  return name ? name : AGENTS_UNNAMED;
}

/**
 * What an agent may do, as the consent page phrased it, in the server's order.
 *
 * A permission this client has no words for is dropped rather than shown as its
 * name: a person should never read ``vault:desk``, and a permission added on the
 * server is caught by the drift guard before it ships without a sentence.
 */
export function grantPhrases(grants: readonly string[]): string[] {
  return grants.flatMap((grant) => {
    const phrase = AGENT_GRANT_PHRASES.get(grant);
    return phrase === undefined ? [] : [phrase];
  });
}

/** Where an agent signs a person in: their own computer, a named site, or nothing known. */
export function whereItSignsIn(redirectHost: string | null): string | null {
  if (redirectHost === null) return null;
  if (LOOPBACK_HOSTS.has(redirectHost.toLowerCase())) return AGENTS_ON_THIS_COMPUTER;
  return `${AGENTS_SIGNS_IN_THROUGH} ${redirectHost}`;
}

/** ``1 minute`` / ``5 minutes``: a count and its unit, singular only for one. */
function counted(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** ``elapsedMs`` in the largest whole unit that fits, or ``null`` once a date says it better. */
function agoPhrase(elapsedMs: number): string | null {
  const minutes = Math.floor(elapsedMs / MS_PER_MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < MINUTES_PER_HOUR) return `${counted(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${counted(hours, 'hour')} ago`;
  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days < DAYS_BEFORE_A_DATE) return `${counted(days, 'day')} ago`;
  return null;
}

/**
 * ``just now``, ``2 hours ago`` or ``on October 1, 2026``: when a moment was,
 * relative to ``now``, or ``null`` for a moment that cannot be read.
 *
 * ``now`` is passed in, so a test pins the clock and a list renders every row
 * against the same instant. A moment in the future -- a device clock that runs
 * slow -- reads as "just now" rather than as a negative count. Shared by the
 * agent rows' "Last used" line and the recent-activity list (#3535).
 */
export function whenPhrase(iso: string, now: number): string | null {
  const moment = new Date(iso);
  const at = moment.getTime();
  if (Number.isNaN(at)) return null;
  const ago = agoPhrase(Math.max(0, now - at));
  if (ago !== null) return ago;
  const date = moment.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `on ${date}`;
}

/**
 * ``Last used 2 hours ago``, ``Last used on October 1, 2026`` or ``Not used yet``.
 *
 * An unparseable moment says nothing about when, rather than inventing one.
 */
export function lastUsedPhrase(lastUsedAt: string | null, now: number): string {
  if (lastUsedAt === null) return AGENTS_NOT_USED_YET;
  const when = whenPhrase(lastUsedAt, now);
  return when === null ? AGENTS_LAST_USED : `${AGENTS_LAST_USED} ${when}`;
}
