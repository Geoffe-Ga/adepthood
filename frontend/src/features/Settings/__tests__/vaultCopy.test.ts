/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import * as vaultCopy from '../vaultCopy';

/**
 * Copy guards for the private-vault Settings surface. The surface is purely
 * informational: it states one promise, says plainly that Adepthood is complete
 * without a vault, and never reaches for technical, pressuring, or durability
 * language. These tests pin the copy deck verbatim and fence off the vocabulary
 * the surface is not allowed to use.
 */

const { VAULT_FLOOR, VAULT_PROMISE, VAULT_ROW_DESCRIPTION, VAULT_ROW_LABEL } = vaultCopy;

/** Every exported copy constant, so a new export cannot slip past the guards. */
const COPY_KEYS = [
  'VAULT_ROW_LABEL',
  'VAULT_ROW_DESCRIPTION',
  'VAULT_EYEBROW',
  'VAULT_TITLE',
  'VAULT_PROMISE',
  'VAULT_WHAT_IT_IS',
  'VAULT_FLOOR',
  'VAULT_INTIMATE',
  'VAULT_SETUP',
] as const;

const ALL_COPY = Object.values(vaultCopy).join(' ');

// Hosts, transports, credentials and routing: the technical vocabulary this
// surface is forbidden to expose, since a vault is configured where it runs.
const BANNED_TECHNICAL =
  /\b(host|hostname|url|uri|endpoint|api key|apikey|bearer|token|credential|mcp|https?|port|protocol|routing|route|server|sync|tenant|node|instance)\b/iu;

// Loss and obligation framing: the copy must never imply entries are at risk
// without a vault, nor that connecting one is required of anybody.
const BANNED_PRESSURE =
  /\b(backup|back up|safeguard|protect|secure your|lose|lost|losing|at risk|danger|failure|required|must|need to)\b/iu;

// Durability promises the write path does not make and cannot keep.
const BANNED_DURABILITY =
  /\b(guarantee|guaranteed|never lose|always safe|permanent|permanently stored)\b/iu;

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------

describe('vaultCopy — export surface', () => {
  for (const key of COPY_KEYS) {
    it(`${key} is a non-empty string`, () => {
      expect(typeof vaultCopy[key]).toBe('string');
      expect(vaultCopy[key].length).toBeGreaterThan(0);
    });
  }

  it('the swept blob carries every exported constant', () => {
    // Anti-vacuity guard: the negative tests below only mean something if the
    // swept blob really contains the whole deck.
    for (const key of COPY_KEYS) {
      expect(ALL_COPY).toContain(vaultCopy[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// Verbatim copy deck — these strings are the contract
// ---------------------------------------------------------------------------

describe('vaultCopy — verbatim copy deck', () => {
  it('VAULT_ROW_LABEL reads "Private vault"', () => {
    expect(VAULT_ROW_LABEL).toBe('Private vault');
  });

  it('VAULT_ROW_DESCRIPTION calls the vault optional and the app complete', () => {
    expect(VAULT_ROW_DESCRIPTION).toBe(
      'An optional copy of what you write, in a space you run yourself. Adepthood is complete without one.',
    );
  });

  it('VAULT_EYEBROW reads "Optional"', () => {
    expect(vaultCopy.VAULT_EYEBROW).toBe('Optional');
  });

  it('VAULT_TITLE reads "Your private vault"', () => {
    expect(vaultCopy.VAULT_TITLE).toBe('Your private vault');
  });

  it('VAULT_PROMISE is the one promise the surface makes', () => {
    expect(VAULT_PROMISE).toBe('Your writing is yours, and it stays as private as you choose.');
  });

  it('VAULT_PROMISE defers to the writer rather than claiming blanket secrecy', () => {
    // An entry marked Public is shareable with the Sangha, so a flat "stays
    // private" would be false for a tier the writer picked themselves.
    expect(VAULT_PROMISE).toMatch(/as you choose/iu);
  });

  it('VAULT_WHAT_IT_IS describes a vault in plain, non-technical terms', () => {
    expect(vaultCopy.VAULT_WHAT_IT_IS).toBe(
      'A private vault is a space you run yourself. When one is connected, Adepthood sends a copy of each entry there as you write — into a place you hold.',
    );
  });

  it('VAULT_FLOOR states the app is complete without a vault', () => {
    expect(VAULT_FLOOR).toBe(
      'Adepthood is complete without a vault. Your journal, your reflections, and everything you have written are all here either way. A vault adds a copy in your own space; nothing else changes.',
    );
  });

  it('VAULT_INTIMATE keeps Intimate entries out of any vault', () => {
    expect(vaultCopy.VAULT_INTIMATE).toBe('Entries you mark Intimate are never sent to a vault.');
  });

  it('VAULT_SETUP says there is nothing to fill in here', () => {
    expect(vaultCopy.VAULT_SETUP).toBe(
      'A vault is set up where it runs, not in the app — so there is nothing to fill in here.',
    );
  });
});

// ---------------------------------------------------------------------------
// Negative guards
// ---------------------------------------------------------------------------

describe('vaultCopy — banned technical vocabulary', () => {
  it('names no host, transport, credential, or routing concept', () => {
    expect(ALL_COPY).not.toMatch(BANNED_TECHNICAL);
  });
});

describe('vaultCopy — no risk or obligation framing', () => {
  it('never implies entries are at risk, nor that a vault is required', () => {
    expect(ALL_COPY).not.toMatch(BANNED_PRESSURE);
  });
});

describe('vaultCopy — no durability claim', () => {
  it('makes no promise the write path cannot keep', () => {
    expect(ALL_COPY).not.toMatch(BANNED_DURABILITY);
  });
});

// ---------------------------------------------------------------------------
// Positive guards
// ---------------------------------------------------------------------------

describe('vaultCopy — the floor is stated outright', () => {
  it('VAULT_FLOOR asserts completeness without a vault', () => {
    expect(VAULT_FLOOR).toMatch(/complete without/iu);
  });
});

describe('vaultCopy — exactly one promise', () => {
  it('VAULT_PROMISE contains exactly one full stop', () => {
    expect(VAULT_PROMISE.split('.').length - 1).toBe(1);
  });

  it('the full stop in VAULT_PROMISE is its final character', () => {
    expect(VAULT_PROMISE.endsWith('.')).toBe(true);
  });
});
