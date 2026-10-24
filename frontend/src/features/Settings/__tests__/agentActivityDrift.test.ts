import { describe, expect, it } from '@jest/globals';

import { BANNED_PRESSURE, BANNED_TECHNICAL } from '@/testing/agentsCopyBans';
import { readBackendSource } from '@/testing/backendSource';

/**
 * The words the activity route writes are held to this section's bans (#3535).
 *
 * ``GET /vault/agents/activity`` names who asked and what for in its own words
 * -- ``backend/src/services/vault_agent_activity_copy.py`` -- and Settings
 * renders them verbatim under "Agents that may read your vault". They are
 * written in Python, so this reads them back and sweeps every one with the same
 * technical and pressure bans the section's own copy obeys: a person should
 * never read "client", "token" or "sync" in a row, and never a tool name.
 */

const ACTIVITY_COPY = ['src', 'services', 'vault_agent_activity_copy.py'];

/** One ``NAME: Final = "phrase"`` constant. */
const CONSTANT = /^ACTIVITY_[A-Z_]+: Final = "([^"]+)"$/gmu;

/** One ``"creek.tool": "phrase",`` line of ``TOOL_LABELS``. */
const TOOL_ENTRY = /^ {8}"(creek\.[^"]+)": "([^"]+)",$/gmu;

const source = readBackendSource(...ACTIVITY_COPY);
const constants = [...source.matchAll(CONSTANT)].map(([, phrase]) => String(phrase));
const tools = [...source.matchAll(TOOL_ENTRY)].map(([, tool, phrase]) => [
  String(tool),
  String(phrase),
]);
const phrases = [...constants, ...tools.map(([, phrase]) => String(phrase))];

describe('the activity route speaks this section’s register', () => {
  it('finds every phrase it sweeps', () => {
    expect(constants.length).toBeGreaterThanOrEqual(6);
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  it('labels the three tools #3535 names in its own words', () => {
    const labels = new Map(tools.map(([tool, phrase]) => [tool, phrase]));
    expect(labels.get('creek.draft')).toBe('Drafted an essay');
    expect(labels.get('creek.reflect')).toBe('Asked for a reflection');
    expect(labels.get('creek.link')).toBe('Tried to re-sort the vault');
  });

  it.each(phrases.map((phrase) => [phrase]))('holds "%s" to the technical ban', (phrase) => {
    expect(phrase).not.toMatch(BANNED_TECHNICAL);
    expect(phrase).not.toMatch(/creek/iu);
  });

  it.each(phrases.map((phrase) => [phrase]))('holds "%s" to the pressure ban', (phrase) => {
    expect(phrase).not.toMatch(BANNED_PRESSURE);
  });
});
