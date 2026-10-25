import { describe, expect, it } from '@jest/globals';

import {
  AGENTS_LAST_USED,
  AGENTS_NOT_USED_YET,
  AGENTS_ON_THIS_COMPUTER,
  AGENTS_UNNAMED,
} from '../agentsCopy';
import {
  agentDisplayName,
  grantPhrases,
  lastUsedPhrase,
  whenPhrase,
  whereItSignsIn,
} from '../connectedAgents';

/**
 * The rules that turn one ``GET /vault/agents`` row into words (#3534).
 *
 * Exact strings throughout: each of these is a sentence a person reads beside
 * a Stop button, and an off-by-one in a unit or a raw permission name in the
 * list is a defect that only an exact assertion sees.
 */

const NOW = Date.parse('2026-10-24T20:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The ISO instant ``ms`` before ``NOW``. */
function before(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('agentDisplayName', () => {
  it('uses the name the agent gave itself', () => {
    expect(agentDisplayName({ name: 'OpenClaw on my Mac mini' })).toBe('OpenClaw on my Mac mini');
  });

  it('says so, in the consent page words, for an agent that gave none', () => {
    expect(agentDisplayName({ name: null })).toBe(AGENTS_UNNAMED);
    expect(agentDisplayName({ name: '   ' })).toBe(AGENTS_UNNAMED);
  });
});

describe('grantPhrases', () => {
  it('maps every permission to its plain phrase, in the order sent', () => {
    expect(grantPhrases(['vault:read', 'vault:desk', 'offline_access'])).toEqual([
      'Read and search your Open and Personal writing',
      'Draft and reflect from your Open and Personal writing',
      'Stay connected without asking you again',
    ]);
  });

  it('never shows a permission name it has no words for', () => {
    const phrases = grantPhrases(['vault:journal', 'vault:telepathy']);

    expect(phrases).toEqual(['Add journal entries']);
    expect(phrases.join(' ')).not.toMatch(/vault:/u);
  });
});

describe('whereItSignsIn', () => {
  it.each(['127.0.0.1', 'localhost', '::1', 'LOCALHOST'])(
    'reads %s as the person own computer',
    (host) => {
      expect(whereItSignsIn(host)).toBe(AGENTS_ON_THIS_COMPUTER);
    },
  );

  it('names the site a hosted agent signs a person in through', () => {
    expect(whereItSignsIn('chatgpt.com')).toBe('Signs in through chatgpt.com');
  });

  it('says nothing when no host could be read', () => {
    expect(whereItSignsIn(null)).toBeNull();
  });
});

describe('lastUsedPhrase', () => {
  it('says an agent approved and never used has not been used', () => {
    expect(lastUsedPhrase(null, NOW)).toBe(AGENTS_NOT_USED_YET);
  });

  it.each([
    [0, 'Last used just now'],
    [59 * 1000, 'Last used just now'],
    [MINUTE, 'Last used 1 minute ago'],
    [59 * MINUTE, 'Last used 59 minutes ago'],
    [HOUR, 'Last used 1 hour ago'],
    [2 * HOUR, 'Last used 2 hours ago'],
    [23 * HOUR + 59 * MINUTE, 'Last used 23 hours ago'],
    [DAY, 'Last used 1 day ago'],
    [29 * DAY, 'Last used 29 days ago'],
  ])('reads %i ms ago as %s', (elapsed, phrase) => {
    expect(lastUsedPhrase(before(elapsed), NOW)).toBe(phrase);
  });

  it('switches to the date once a count stops meaning much', () => {
    const at = before(30 * DAY);
    const date = new Date(at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    expect(lastUsedPhrase(at, NOW)).toBe(`Last used on ${date}`);
  });

  it('reads a moment ahead of a slow device clock as just now, never a negative count', () => {
    expect(lastUsedPhrase(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe(
      'Last used just now',
    );
  });

  it('invents no time for a moment it cannot read', () => {
    expect(lastUsedPhrase('not a time', NOW)).toBe(AGENTS_LAST_USED);
  });
});

describe('whenPhrase', () => {
  it('says how long ago, without a prefix, in the largest whole unit', () => {
    expect(whenPhrase(before(10 * 1000), NOW)).toBe('just now');
    expect(whenPhrase(before(MINUTE), NOW)).toBe('1 minute ago');
    expect(whenPhrase(before(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(whenPhrase(before(2 * DAY), NOW)).toBe('2 days ago');
  });

  it('gives a date once a count stops meaning much', () => {
    expect(whenPhrase(before(45 * DAY), NOW)).toMatch(/^on /u);
  });

  it('reads a moment in the future as just now', () => {
    expect(whenPhrase(new Date(NOW + HOUR).toISOString(), NOW)).toBe('just now');
  });

  it('says nothing about a moment it cannot read', () => {
    expect(whenPhrase('not a time', NOW)).toBeNull();
  });
});
