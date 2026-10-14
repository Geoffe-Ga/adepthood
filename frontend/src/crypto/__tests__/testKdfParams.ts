import type { KdfParams } from '../kdf';

/**
 * TEST-ONLY Argon2id parameters. They are far too cheap to protect a real
 * passphrase and exist so the wrap/unwrap suites run in milliseconds. They live
 * under `__tests__/` so no production module can import them, and every suite
 * that uses them passes them explicitly: the production default is never
 * lowered to reach them.
 */
export const TEST_ONLY_KDF_PARAMS: KdfParams = Object.freeze({
  algorithm: 'argon2id',
  iterations: 1,
  memoryKiB: 64,
  parallelism: 1,
});
