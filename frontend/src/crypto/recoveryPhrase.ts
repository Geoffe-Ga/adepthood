/**
 * The recovery phrase (ADR 0009 Decision item 11): 24 words from the English
 * BIP-39 wordlist, 256 bits of entropy plus an 8-bit checksum, which the person
 * writes down. Either it or their passphrase unlocks the data key.
 *
 * It is normalised before validation and derivation, so a phrase typed with
 * different case, spacing or Unicode composition derives the same key.
 */
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { EnvelopeError } from './errors';

const RECOVERY_PHRASE_STRENGTH_BITS = 256;
export const RECOVERY_PHRASE_WORD_COUNT = 24;

/** A new phrase from the platform CSPRNG (via WebCrypto getRandomValues). */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, RECOVERY_PHRASE_STRENGTH_BITS);
}

/** Lowercase, NFKD, then trim and collapse every run of whitespace to one space. */
export function normaliseRecoveryPhrase(input: string): string {
  return input.toLowerCase().normalize('NFKD').trim().split(/\s+/u).join(' ');
}

/** Throw a content-free `invalid_recovery_phrase` unless `normalised` is a valid 24-word phrase. */
export function assertValidRecoveryPhrase(normalised: string): void {
  const hasWordCount = normalised.split(' ').length === RECOVERY_PHRASE_WORD_COUNT;
  if (!hasWordCount || !validateMnemonic(normalised, wordlist)) {
    throw new EnvelopeError('invalid_recovery_phrase');
  }
}
