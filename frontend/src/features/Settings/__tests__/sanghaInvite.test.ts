import { describe, expect, it } from '@jest/globals';

import {
  SANGHA_DECLINE_HINT,
  SANGHA_LEAD,
  SANGHA_ROW_DESCRIPTION,
  SANGHA_ROW_LABEL,
  SANGHA_SECTION_TITLE,
  sanghaInviteUrl,
} from '../sanghaInvite';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

/**
 * The Digital Sangha invite: how a configured URL is resolved, and what its
 * copy is forbidden from saying.
 *
 * The resolver fails *closed*. An unset or malformed invite must produce no
 * surface at all rather than a row that opens nothing — a store binary cannot
 * be patched, so a dead door is worse than no door.
 */

const CONFIGURED = 'https://discord.gg/example-sangha';

/** Every string the Sangha surface can put in front of a person. */
const ALL_COPY: readonly string[] = [
  SANGHA_SECTION_TITLE,
  SANGHA_LEAD,
  SANGHA_DECLINE_HINT,
  SANGHA_ROW_LABEL,
  SANGHA_ROW_DESCRIPTION,
];

describe('sanghaInviteUrl', () => {
  it('returns a configured https invite verbatim', () => {
    expect(sanghaInviteUrl(CONFIGURED)).toBe(CONFIGURED);
  });

  it('trims the whitespace an env var picks up from a shell or CI secret', () => {
    expect(sanghaInviteUrl(`  ${CONFIGURED}\n`)).toBe(CONFIGURED);
  });

  it('resolves nothing when the invite is unset, so no surface is offered', () => {
    expect(sanghaInviteUrl('')).toBeNull();
  });

  it('resolves nothing for whitespace, which an unset CI variable expands to', () => {
    expect(sanghaInviteUrl('   ')).toBeNull();
  });

  it('refuses http, which is downgrade-prone', () => {
    expect(sanghaInviteUrl('http://discord.gg/example-sangha')).toBeNull();
  });

  it('refuses a custom scheme, which is an app-hijack vector', () => {
    expect(sanghaInviteUrl('discord://invite/example-sangha')).toBeNull();
  });

  it('refuses a bare scheme with nothing behind it', () => {
    expect(sanghaInviteUrl('https://')).toBeNull();
  });
});

describe('Sangha copy', () => {
  it('never ranks or shames the reader', () => {
    for (const line of ALL_COPY) {
      expect(ranksOrShames(line)).toBe(false);
    }
  });

  it('carries no number anywhere, so a community can never become a metric', () => {
    // A member count, an unread badge, or "3 people are online" would all
    // arrive as a digit. Forbidding digits outright is what keeps them out.
    for (const line of ALL_COPY) {
      expect(line).not.toMatch(/\d/u);
    }
  });

  it('never issues the "Join" call to action', () => {
    for (const line of ALL_COPY) {
      expect(line).not.toMatch(/\bjoin\b/iu);
    }
  });

  it('raises its voice at nobody', () => {
    for (const line of ALL_COPY) {
      expect(line).not.toContain('!');
    }
  });

  it('says the app is whole without the Sangha rather than incomplete with it', () => {
    expect(SANGHA_LEAD).toMatch(/whole without it/u);
  });

  it('names the mechanism that closes the door, so declining needs no hunting', () => {
    expect(SANGHA_DECLINE_HINT).toMatch(/Choose your depths/u);
  });

  it('warns that the row hands the reader to Discord and its own terms', () => {
    expect(SANGHA_ROW_DESCRIPTION).toMatch(/Discord/u);
    expect(SANGHA_ROW_DESCRIPTION).toMatch(/terms/iu);
  });
});
