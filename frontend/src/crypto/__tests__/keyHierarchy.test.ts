import { describe, expect, it, jest } from '@jest/globals';
import { bytesToHex } from '@noble/hashes/utils.js';

import { EnvelopeError, type EnvelopeFailure } from '../errors';
import * as kdf from '../kdf';
import { PRODUCTION_KDF_PARAMS } from '../kdf';
import {
  DATA_KEY_BYTES,
  generateDataKey,
  unwrapWithPassphrase,
  unwrapWithRecoveryPhrase,
  wrapDataKey,
  type WrappedDataKeys,
} from '../keyHierarchy';
import { generateRecoveryPhrase } from '../recoveryPhrase';

import { TEST_ONLY_KDF_PARAMS } from './testKdfParams';

const OWNER = 'owner-a';
const PASSPHRASE = 'correct horse battery staple, by the creek';
const WRAP_VERSION = 2;
const KEY_SAMPLE_SIZE = 64;

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
    const { recoveryPhrase, wrapped } = await enrolFixture();
    const words = recoveryPhrase.split(' ');
    const broken = [...words.slice(0, -1), words.at(-1) === 'zoo' ? 'zone' : 'zoo'].join(' ');

    await expectFailure(
      () =>
        unwrapWithRecoveryPhrase(wrapped.recoveryPhrase, {
          ownerId: OWNER,
          recoveryPhrase: broken,
          minWrapVersion: WRAP_VERSION,
        }),
      'invalid_recovery_phrase',
    );
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

  it('a stored record with weakened KDF parameters fails closed', async () => {
    const { wrapped } = await enrolFixture();
    const weakened = {
      ...wrapped.passphrase,
      kdf: { ...wrapped.passphrase.kdf, memoryKiB: wrapped.passphrase.kdf.memoryKiB / 2 },
    };

    await expectFailure(
      () =>
        unwrapWithPassphrase(weakened, {
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

  it('refuses KDF parameters the algorithm cannot run', async () => {
    await expectFailure(
      () =>
        wrapDataKey({
          dataKey: generateDataKey(),
          ownerId: OWNER,
          passphrase: PASSPHRASE,
          recoveryPhrase: generateRecoveryPhrase(),
          wrapVersion: WRAP_VERSION,
          kdfParams: { ...TEST_ONLY_KDF_PARAMS, memoryKiB: 1 },
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
    const rendered = [error.message, String(error), error.stack ?? '', JSON.stringify(error)].join(
      '\n',
    );

    for (const secret of [
      PASSPHRASE,
      bytesToHex(dataKey),
      ...recoveryPhrase.split(' ').filter((w) => w.length > 4),
    ]) {
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

    const wrapped = await wrapDataKey({
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
