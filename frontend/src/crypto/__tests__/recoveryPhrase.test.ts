import { describe, expect, it } from '@jest/globals';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { EnvelopeError } from '../errors';
import {
  RECOVERY_PHRASE_WORD_COUNT,
  assertValidRecoveryPhrase,
  generateRecoveryPhrase,
  normaliseRecoveryPhrase,
} from '../recoveryPhrase';

// BIP-39 reference vector: all-zero 256-bit entropy (trezor/python-mnemonic vectors.json).
const ZERO_ENTROPY_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PHRASE_SAMPLE_SIZE = 50;
const IDEOGRAPHIC_SPACE = '\u3000';

describe('recovery phrase', () => {
  it('generates 24 English BIP-39 words that pass the checksum', () => {
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(' ');

    expect(RECOVERY_PHRASE_WORD_COUNT).toBe(24);
    expect(words).toHaveLength(RECOVERY_PHRASE_WORD_COUNT);
    for (const word of words) {
      expect(wordlist).toContain(word);
    }
    expect(() => assertValidRecoveryPhrase(phrase)).not.toThrow();
  });

  it('never repeats a phrase across draws', () => {
    const phrases = new Set<string>();
    for (let i = 0; i < PHRASE_SAMPLE_SIZE; i += 1) {
      phrases.add(generateRecoveryPhrase());
    }

    expect(phrases.size).toBe(PHRASE_SAMPLE_SIZE);
  });

  it('normalises case, NFKD form and every run of whitespace to single spaces', () => {
    const messy = `  ABANDON\tAbandon\n${'abandon '.repeat(20)}${IDEOGRAPHIC_SPACE}abandon   ART `;

    expect(normaliseRecoveryPhrase(messy)).toBe(ZERO_ENTROPY_PHRASE);
  });

  it('decomposes compatibility characters (NFKD)', () => {
    // U+FB01 LATIN SMALL LIGATURE FI decomposes to "fi" under NFKD only.
    expect(normaliseRecoveryPhrase('\uFB01eld')).toBe('field');
    // A precomposed e-acute becomes e + combining acute.
    expect(normaliseRecoveryPhrase('\u00E9')).toBe('e\u0301');
  });

  it('accepts the published all-zero vector after normalisation', () => {
    expect(() =>
      assertValidRecoveryPhrase(normaliseRecoveryPhrase(ZERO_ENTROPY_PHRASE.toUpperCase())),
    ).not.toThrow();
  });

  it.each([
    ['a bad checksum', ZERO_ENTROPY_PHRASE.replace(/art$/u, 'abandon')],
    ['a word outside the list', ZERO_ENTROPY_PHRASE.replace(/art$/u, 'heron')],
    [
      'too few words',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ],
    ['an empty phrase', ''],
  ])('rejects %s with a content-free error', (_label, phrase) => {
    let caught: unknown;
    try {
      assertValidRecoveryPhrase(phrase);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvelopeError);
    expect((caught as EnvelopeError).code).toBe('invalid_recovery_phrase');
    if (phrase !== '') {
      expect((caught as EnvelopeError).message).not.toContain(phrase.split(' ').at(-1));
    }
  });
});
