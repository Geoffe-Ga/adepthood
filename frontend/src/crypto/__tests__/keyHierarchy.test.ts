import { describe, expect, it, jest } from '@jest/globals';
import { bytesToHex } from '@noble/hashes/utils.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { EnvelopeError, type EnvelopeFailure } from '../errors';
import * as kdf from '../kdf';
import {
  KDF_SALT_BYTES,
  MAX_KDF_ITERATIONS,
  MAX_KDF_MEMORY_KIB,
  MAX_KDF_WORK_KIB_PASSES,
  PRODUCTION_KDF_PARAMS,
  deriveArgon2id,
  type KdfParams,
} from '../kdf';
import * as productionApi from '../keyHierarchy';
import {
  DATA_KEY_BYTES,
  generateDataKey,
  type WrappedDataKey,
  type WrappedDataKeys,
} from '../keyHierarchy';
import { generateRecoveryPhrase } from '../recoveryPhrase';

import { TEST_ONLY_KDF_PARAMS } from './testKdfParams';
import { testOnlyKeyHierarchy } from './testKeyHierarchy';

const { wrapDataKey, unwrapWithPassphrase, unwrapWithRecoveryPhrase } = testOnlyKeyHierarchy;

const OWNER = 'owner-a';
const PASSPHRASE = 'correct horse battery staple, by the creek';
const WRAP_VERSION = 2;
const KEY_SAMPLE_SIZE = 64;
const BIP39_WORD_COUNT = 24;
const BROKEN_CHECKSUM_PHRASE = Array.from({ length: BIP39_WORD_COUNT }, () => 'abandon').join(' ');

async function failureOf(action: () => Promise<unknown>): Promise<EnvelopeError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof EnvelopeError) {
      return error;
    }
    throw new Error(`expected an EnvelopeError, got ${String(error)}`);
  }
  throw new Error('expected the unwrap to fail closed, but it succeeded');
}

async function expectFailure(
  action: () => Promise<unknown>,
  code: EnvelopeFailure,
): Promise<EnvelopeError> {
  const error = await failureOf(action);
  expect(error.code).toBe(code);
  return error;
}

async function enrolFixture(): Promise<{
  dataKey: Uint8Array;
  recoveryPhrase: string;
  wrapped: WrappedDataKeys;
}> {
  const dataKey = generateDataKey();
  const recoveryPhrase = generateRecoveryPhrase();
  const wrapped = await wrapDataKey({
    dataKey,
    ownerId: OWNER,
    passphrase: PASSPHRASE,
    recoveryPhrase,
    wrapVersion: WRAP_VERSION,
    kdfParams: TEST_ONLY_KDF_PARAMS,
  });
  return { dataKey, recoveryPhrase, wrapped };
}

describe('data key', () => {
  it('is 256 random bits, distinct on every draw', () => {
    const keys = new Set<string>();
    for (let i = 0; i < KEY_SAMPLE_SIZE; i += 1) {
      const key = generateDataKey();
      expect(key).toHaveLength(DATA_KEY_BYTES);
      keys.add(bytesToHex(key));
    }

    expect(DATA_KEY_BYTES).toBe(32);
    expect(keys.size).toBe(KEY_SAMPLE_SIZE);
  });

  it('comes from WebCrypto getRandomValues', () => {
    const spy = jest.spyOn(globalThis.crypto, 'getRandomValues');

    generateDataKey();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('key wrapping', () => {
  it('passphrase and recovery phrase each unwrap the same data key', async () => {
    const { dataKey, recoveryPhrase, wrapped } = await enrolFixture();

    const viaPassphrase = await unwrapWithPassphrase(wrapped.passphrase, {
      ownerId: OWNER,
      passphrase: PASSPHRASE,
      minWrapVersion: WRAP_VERSION,
    });
    const viaPhrase = await unwrapWithRecoveryPhrase(wrapped.recoveryPhrase, {
      ownerId: OWNER,
      recoveryPhrase,
      minWrapVersion: WRAP_VERSION,
    });

    expect(bytesToHex(viaPassphrase)).toBe(bytesToHex(dataKey));
    expect(bytesToHex(viaPhrase)).toBe(bytesToHex(dataKey));
  });

  it('wraps under independent salts and records purpose and KDF parameters', async () => {
    const { dataKey, wrapped } = await enrolFixture();

    expect(wrapped.passphrase.purpose).toBe('passphrase');
    expect(wrapped.recoveryPhrase.purpose).toBe('recovery-phrase');
    expect(wrapped.passphrase.kdf).toEqual(TEST_ONLY_KDF_PARAMS);
    expect(bytesToHex(wrapped.passphrase.salt)).not.toBe(bytesToHex(wrapped.recoveryPhrase.salt));
    expect(bytesToHex(wrapped.passphrase.envelope)).not.toContain(bytesToHex(dataKey));
  });

  it('unwraps a recovery phrase typed with different case and spacing', async () => {
    const { dataKey, recoveryPhrase, wrapped } = await enrolFixture();
    const typed = `  ${recoveryPhrase.toUpperCase().split(' ').join('   ')}\n`;

    const key = await unwrapWithRecoveryPhrase(wrapped.recoveryPhrase, {
      ownerId: OWNER,
      recoveryPhrase: typed,
      minWrapVersion: WRAP_VERSION,
    });

    expect(bytesToHex(key)).toBe(bytesToHex(dataKey));
  });

  it('unwraps a passphrase typed in a different Unicode composition', async () => {
    const dataKey = generateDataKey();
    const wrapped = await wrapDataKey({
      dataKey,
      ownerId: OWNER,
      passphrase: 'caf\u00E9 by the creek',
      recoveryPhrase: generateRecoveryPhrase(),
      wrapVersion: WRAP_VERSION,
      kdfParams: TEST_ONLY_KDF_PARAMS,
    });

    const key = await unwrapWithPassphrase(wrapped.passphrase, {
      ownerId: OWNER,
      passphrase: 'cafe\u0301 by the creek',
      minWrapVersion: WRAP_VERSION,
    });

    expect(bytesToHex(key)).toBe(bytesToHex(dataKey));
  });

  it('a wrong passphrase fails closed', async () => {
    const { wrapped } = await enrolFixture();

    await expectFailure(
      () =>
        unwrapWithPassphrase(wrapped.passphrase, {
          ownerId: OWNER,
          passphrase: `${PASSPHRASE}!`,
          minWrapVersion: WRAP_VERSION,
        }),
      'authentication_failed',
    );
  });

  it('a different valid recovery phrase fails closed', async () => {
    const { wrapped } = await enrolFixture();

    await expectFailure(
      () =>
        unwrapWithRecoveryPhrase(wrapped.recoveryPhrase, {
          ownerId: OWNER,
          recoveryPhrase: generateRecoveryPhrase(),
          minWrapVersion: WRAP_VERSION,
        }),
      'authentication_failed',
    );
  });

  it('a recovery phrase with a broken checksum is refused before derivation', async () => {
    const { wrapped } = await enrolFixture();
    // Fixed, not random: 24 x "abandon" is the all-zero-entropy phrase with the
    // wrong final word (the valid one ends in "art"), so it fails the checksum
    // on every run. The precondition proves it, so the test cannot pass by luck.
    expect(validateMnemonic(BROKEN_CHECKSUM_PHRASE, wordlist)).toBe(false);
    const derive = jest.spyOn(kdf, 'deriveArgon2id');

    await expectFailure(
      () =>
        unwrapWithRecoveryPhrase(wrapped.recoveryPhrase, {
          ownerId: OWNER,
          recoveryPhrase: BROKEN_CHECKSUM_PHRASE,
          minWrapVersion: WRAP_VERSION,
        }),
      'invalid_recovery_phrase',
    );
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  it("another owner's binding fails closed", async () => {
    const { wrapped } = await enrolFixture();

    await expectFailure(
      () =>
        unwrapWithPassphrase(wrapped.passphrase, {
          ownerId: 'owner-b',
          passphrase: PASSPHRASE,
          minWrapVersion: WRAP_VERSION,
        }),
      'authentication_failed',
    );
  });

  it('a wrap presented under the other purpose fails closed', async () => {
    const { wrapped } = await enrolFixture();

    await expectFailure(
      () =>
        unwrapWithPassphrase(
          { ...wrapped.recoveryPhrase, purpose: 'passphrase' },
          { ownerId: OWNER, passphrase: PASSPHRASE, minWrapVersion: WRAP_VERSION },
        ),
      'authentication_failed',
    );
  });

  it('a wrap relabelled to the other purpose fails even when both secrets are the same string', async () => {
    // With equal secrets, each record's own salt and parameters derive the
    // same wrapping key under either label, so only the purpose bound into
    // the AAD can tell the two wraps apart.
    const recoveryPhrase = generateRecoveryPhrase();
    const wrapped = await wrapDataKey({
      dataKey: generateDataKey(),
      ownerId: OWNER,
      passphrase: recoveryPhrase,
      recoveryPhrase,
      wrapVersion: WRAP_VERSION,
      kdfParams: TEST_ONLY_KDF_PARAMS,
    });

    await expectFailure(
      () =>
        unwrapWithPassphrase(
          { ...wrapped.recoveryPhrase, purpose: 'passphrase' },
          { ownerId: OWNER, passphrase: recoveryPhrase, minWrapVersion: WRAP_VERSION },
        ),
      'authentication_failed',
    );
  });

  it('a stored record whose KDF parameters were altered within bounds fails closed', async () => {
    // Argon2id hashes t, m and p into its first block, so a record whose
    // parameters were changed derives a different key and cannot authenticate.
    const { wrapped } = await enrolFixture();
    const altered = {
      ...wrapped.passphrase,
      kdf: { ...wrapped.passphrase.kdf, iterations: wrapped.passphrase.kdf.iterations + 1 },
    };

    await expectFailure(
      () =>
        unwrapWithPassphrase(altered, {
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          minWrapVersion: WRAP_VERSION,
        }),
      'authentication_failed',
    );
  });

  it('a replayed older wrap is refused', async () => {
    const { wrapped } = await enrolFixture();

    await expectFailure(
      () =>
        unwrapWithPassphrase(wrapped.passphrase, {
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          minWrapVersion: WRAP_VERSION + 1,
        }),
      'rollback',
    );
  });

  it('refuses to wrap a data key of the wrong length', async () => {
    await expectFailure(
      () =>
        wrapDataKey({
          dataKey: new Uint8Array(DATA_KEY_BYTES - 1),
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          recoveryPhrase: generateRecoveryPhrase(),
          wrapVersion: WRAP_VERSION,
          kdfParams: TEST_ONLY_KDF_PARAMS,
        }),
      'invalid_input',
    );
  });

  it('refuses an empty passphrase', async () => {
    await expectFailure(
      () =>
        wrapDataKey({
          dataKey: generateDataKey(),
          ownerId: OWNER,
          passphrase: '',
          recoveryPhrase: generateRecoveryPhrase(),
          wrapVersion: WRAP_VERSION,
          kdfParams: TEST_ONLY_KDF_PARAMS,
        }),
      'invalid_input',
    );
  });

  it('maps a parameter set the Argon2 library refuses to a content-free invalid_input', async () => {
    await expectFailure(
      () =>
        deriveArgon2id(new Uint8Array(1), new Uint8Array(KDF_SALT_BYTES), {
          ...TEST_ONLY_KDF_PARAMS,
          memoryKiB: 1,
        }),
      'invalid_input',
    );
  });

  it('no secret reaches an error or the console when an unwrap fails', async () => {
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { dataKey, recoveryPhrase, wrapped } = await enrolFixture();

    const error = await expectFailure(
      () =>
        unwrapWithRecoveryPhrase(wrapped.passphrase, {
          ownerId: OWNER,
          recoveryPhrase,
          minWrapVersion: WRAP_VERSION,
        }),
      'authentication_failed',
    );
    // The message is a fixed constant per code, and the error carries no
    // fields beyond name and code, so no secret word can be in either. The
    // stack is checked for whole secrets only: single BIP-39 words such as
    // "process" legitimately occur in Node's stack-frame paths.
    expect(error.message).toBe(new EnvelopeError('authentication_failed').message);
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    const rendered = [error.message, String(error), error.stack ?? '', JSON.stringify(error)].join(
      '\n',
    );
    for (const secret of [PASSPHRASE, bytesToHex(dataKey), recoveryPhrase]) {
      expect(rendered).not.toContain(secret);
    }
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe('production KDF parameters', () => {
  it('are Argon2id at 64 MiB, 3 passes, 1 lane, and frozen', () => {
    expect(PRODUCTION_KDF_PARAMS).toEqual({
      algorithm: 'argon2id',
      iterations: 3,
      memoryKiB: 65_536,
      parallelism: 1,
    });
    expect(Object.isFrozen(PRODUCTION_KDF_PARAMS)).toBe(true);
  });

  it('are what a wrap derives with when no parameters are injected', async () => {
    // One real derivation at these parameters takes ~1.3 s in Node but ~20 s
    // inside Jest's VM, so the derivation is stubbed here and the parameters
    // it receives are asserted instead. The algorithm itself is pinned by the
    // RFC 9106 known-answer test.
    const derive = jest
      .spyOn(kdf, 'deriveArgon2id')
      .mockImplementation(() => Promise.resolve(new Uint8Array(DATA_KEY_BYTES).fill(0x5a)));

    const wrapped = await productionApi.wrapDataKey({
      dataKey: generateDataKey(),
      ownerId: OWNER,
      passphrase: PASSPHRASE,
      recoveryPhrase: generateRecoveryPhrase(),
      wrapVersion: WRAP_VERSION,
    });

    expect(derive).toHaveBeenCalledTimes(2);
    for (const [, , params] of derive.mock.calls) {
      expect(params).toBe(PRODUCTION_KDF_PARAMS);
    }
    expect(wrapped.passphrase.kdf).toBe(PRODUCTION_KDF_PARAMS);
    expect(wrapped.recoveryPhrase.kdf).toBe(PRODUCTION_KDF_PARAMS);
    derive.mockRestore();
  });
});

describe('KDF parameter bounds', () => {
  const STUB_KEY = new Uint8Array(DATA_KEY_BYTES).fill(0x5a);
  const ONE_GIB_IN_KIB = 1024 * 1024;

  function spyOnDerive() {
    return jest.spyOn(kdf, 'deriveArgon2id').mockImplementation(() => Promise.resolve(STUB_KEY));
  }

  async function expectRejectedBeforeDerivation(
    action: () => Promise<unknown>,
    code: EnvelopeFailure,
  ): Promise<void> {
    const derive = spyOnDerive();
    try {
      await expectFailure(action, code);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  }

  function withKdf(
    record: WrappedDataKey,
    override: Partial<Record<keyof KdfParams, unknown>>,
  ): WrappedDataKey {
    return { ...record, kdf: { ...record.kdf, ...override } as KdfParams };
  }

  it('names a ceiling of 10 passes, 256 MiB and four times the production work', () => {
    expect(MAX_KDF_ITERATIONS).toBe(10);
    expect(MAX_KDF_MEMORY_KIB).toBe(256 * 1024);
    expect(MAX_KDF_WORK_KIB_PASSES).toBe(
      4 * PRODUCTION_KDF_PARAMS.iterations * PRODUCTION_KDF_PARAMS.memoryKiB,
    );
  });

  it('the public wrap refuses parameters below the production floor', async () => {
    await expectRejectedBeforeDerivation(
      () =>
        productionApi.wrapDataKey({
          dataKey: generateDataKey(),
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          recoveryPhrase: generateRecoveryPhrase(),
          wrapVersion: WRAP_VERSION,
          kdfParams: TEST_ONLY_KDF_PARAMS,
        }),
      'kdf_out_of_bounds',
    );
  });

  it('the public wrap accepts parameters raised above the production floor', async () => {
    const raised = { ...PRODUCTION_KDF_PARAMS, iterations: PRODUCTION_KDF_PARAMS.iterations + 1 };
    const derive = spyOnDerive();

    const wrapped = await productionApi.wrapDataKey({
      dataKey: generateDataKey(),
      ownerId: OWNER,
      passphrase: PASSPHRASE,
      recoveryPhrase: generateRecoveryPhrase(),
      wrapVersion: WRAP_VERSION,
      kdfParams: raised,
    });

    expect(wrapped.passphrase.kdf).toEqual(raised);
    expect(derive).toHaveBeenCalledTimes(2);
    derive.mockRestore();
  });

  it('the public unwrap refuses a stored record below the production floor', async () => {
    const { wrapped } = await enrolFixture();

    await expectRejectedBeforeDerivation(
      () =>
        productionApi.unwrapWithPassphrase(wrapped.passphrase, {
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          minWrapVersion: WRAP_VERSION,
        }),
      'kdf_out_of_bounds',
    );
  });

  it('the test-only seam still refuses a wrap below its own floor', async () => {
    await expectRejectedBeforeDerivation(
      () =>
        wrapDataKey({
          dataKey: generateDataKey(),
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          recoveryPhrase: generateRecoveryPhrase(),
          wrapVersion: WRAP_VERSION,
          kdfParams: { ...TEST_ONLY_KDF_PARAMS, memoryKiB: TEST_ONLY_KDF_PARAMS.memoryKiB / 2 },
        }),
      'kdf_out_of_bounds',
    );
  });

  it.each([
    ['inflated iterations (1e6)', { iterations: 1e6 }],
    ['inflated iterations (2^31)', { iterations: 2 ** 31 }],
    ['iterations one above the ceiling', { iterations: MAX_KDF_ITERATIONS + 1 }],
    ['inflated memory (1 GiB)', { memoryKiB: ONE_GIB_IN_KIB }],
    ['memory one above the ceiling', { memoryKiB: MAX_KDF_MEMORY_KIB + 1 }],
    [
      'each value at its ceiling but the work over the cap',
      { iterations: MAX_KDF_ITERATIONS, memoryKiB: MAX_KDF_MEMORY_KIB },
    ],
    ['fractional iterations', { iterations: 1.5 }],
    ['non-numeric memory', { memoryKiB: Number.NaN }],
    ['another Argon2 variant', { algorithm: 'argon2d' }],
    ['more than one lane', { parallelism: 4 }],
  ])('a stored record with %s is refused before deriving', async (_label, override) => {
    const { wrapped } = await enrolFixture();
    const record = withKdf(wrapped.passphrase, override);

    await expectRejectedBeforeDerivation(
      () =>
        unwrapWithPassphrase(record, {
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          minWrapVersion: WRAP_VERSION,
        }),
      'kdf_out_of_bounds',
    );
    await expectRejectedBeforeDerivation(
      () =>
        productionApi.unwrapWithPassphrase(
          withKdf(withKdf(wrapped.passphrase, { ...PRODUCTION_KDF_PARAMS }), override),
          {
            ownerId: OWNER,
            passphrase: PASSPHRASE,
            minWrapVersion: WRAP_VERSION,
          },
        ),
      'kdf_out_of_bounds',
    );
  });

  it('a production-memory record with 2^31 passes is refused by the public unwrap', async () => {
    const { wrapped } = await enrolFixture();
    const record = withKdf(wrapped.passphrase, { ...PRODUCTION_KDF_PARAMS, iterations: 2 ** 31 });

    await expectRejectedBeforeDerivation(
      () =>
        productionApi.unwrapWithRecoveryPhrase(record, {
          ownerId: OWNER,
          recoveryPhrase: generateRecoveryPhrase(),
          minWrapVersion: WRAP_VERSION,
        }),
      'kdf_out_of_bounds',
    );
  });

  it.each([
    ['short', KDF_SALT_BYTES - 1],
    ['long', KDF_SALT_BYTES + 1],
    ['empty', 0],
  ])('a stored record with a %s salt is refused before deriving', async (_label, length) => {
    const { wrapped } = await enrolFixture();
    const record = { ...wrapped.passphrase, salt: new Uint8Array(length) };

    await expectRejectedBeforeDerivation(
      () =>
        unwrapWithPassphrase(record, {
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          minWrapVersion: WRAP_VERSION,
        }),
      'malformed',
    );
  });
});
