import { describe, expect, it } from '@jest/globals';

import * as agentsCopy from '../agentsCopy';

import { BANNED_PRESSURE, BANNED_TECHNICAL } from '@/testing/agentsCopyBans';

/**
 * Copy guards for "Agents that may read your vault" (#3534).
 *
 * The same three bans ``vaultCopy.test.ts`` holds that deck to, widened by the
 * vocabulary this section is most tempted to leak: the authorization machinery
 * that brings an agent here. A person approved a program; they did not mint a
 * scope for a client, and nothing they read should say so. Headings carry the
 * plain name and never "Creek" (#3007). And no line may imply that connecting
 * an agent is expected of anybody, or that going without one loses anything.
 *
 * The export surface is checked first and both ways, so a string added to the
 * module is swept the day it is added rather than the day somebody lists it.
 */

const { AGENT_GRANT_PHRASES, ...strings } = agentsCopy;

/** Every sentence a person can read in the section, grant phrases included. */
const ALL_SENTENCES: readonly string[] = [
  ...Object.values(strings),
  ...AGENT_GRANT_PHRASES.values(),
];
const ALL_COPY = ALL_SENTENCES.join(' ');

/** The lines that title the section: no product name, no technical word. */
const HEADINGS = [agentsCopy.AGENTS_EYEBROW, agentsCopy.AGENTS_HEADING];

describe('agentsCopy — export surface', () => {
  it('exports only strings, beside the one grant mapping', () => {
    for (const [key, value] of Object.entries(strings)) {
      expect([key, typeof value]).toEqual([key, 'string']);
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('carries every export into the blob the bans sweep', () => {
    expect(Object.keys(strings).length).toBeGreaterThan(0);
    for (const sentence of ALL_SENTENCES) {
      expect(ALL_COPY).toContain(sentence);
    }
  });
});

describe('agentsCopy — the deck, verbatim', () => {
  it('names the section in plain words, under the same eyebrow as the screen', () => {
    expect(agentsCopy.AGENTS_EYEBROW).toBe('Optional');
    expect(agentsCopy.AGENTS_HEADING).toBe('Agents that may read your vault');
  });

  it('explains an agent in the register of the vault deck, with the floor last', () => {
    expect(agentsCopy.AGENTS_WHAT_THEY_ARE).toBe(
      'An agent you run elsewhere can draft and reflect from the Open and Personal writing in your vault. Intimate entries are never included. You can stop any of them here. Adepthood is complete without this.',
    );
  });

  it('says how an agent gets here when there is none, and promises no button', () => {
    expect(agentsCopy.AGENTS_EMPTY).toContain("Approve one from the agent's own sign-in flow");
    expect(agentsCopy.AGENTS_EMPTY).not.toMatch(/\b(tap|press|click|button|add one here)\b/iu);
  });

  it('asks before stopping, and says stopping can be undone from the agent', () => {
    expect(agentsCopy.AGENTS_STOP_CONFIRM).toMatch(/^Stop this agent\?/u);
    expect(agentsCopy.AGENTS_STOP_CONFIRM).toMatch(/approve it again/iu);
  });

  it('names an agent that gave no name in the consent page words', () => {
    expect(agentsCopy.AGENTS_UNNAMED).toBe('An agent that did not give its name');
  });

  it('never reads a failed list as an empty one', () => {
    expect(agentsCopy.AGENTS_LOAD_FAILED).not.toMatch(/\bno agent\b/iu);
  });
});

describe('agentsCopy — the bans', () => {
  it('keeps "Creek" and every technical word out of the headings', () => {
    for (const heading of HEADINGS) {
      expect(heading).not.toMatch(/creek/iu);
      expect(heading).not.toMatch(BANNED_TECHNICAL);
    }
  });

  it.each(ALL_SENTENCES.map((sentence) => [sentence]))(
    'holds "%s" to the technical ban',
    (sentence) => {
      expect(sentence).not.toMatch(BANNED_TECHNICAL);
    },
  );

  it.each(ALL_SENTENCES.map((sentence) => [sentence]))(
    'holds "%s" to the pressure ban',
    (sentence) => {
      expect(sentence).not.toMatch(BANNED_PRESSURE);
    },
  );

  it('names the Intimate floor and the app floor exactly once each', () => {
    expect(ALL_COPY.match(/Intimate entries are never included/gu) ?? []).toHaveLength(1);
    expect(ALL_COPY.match(/complete without/giu) ?? []).toHaveLength(1);
  });
});
