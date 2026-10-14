import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const FRONTEND_ROOT = resolve(__dirname, '..');

/** Use Node's real installed dependency, outside React Native/Jest module mocks. */
const CHECK_INSTALLED_FORGE = `
const forge = require('node-forge');
const { generateKeyPairSync } = require('node:crypto');
const fixture = require('./__tests__/fixtures/nodeForgeDigestAlgorithm.json');
const digest = forge.md.sha256.create().update(fixture.message).digest().getBytes();
function verify(publicKey, signature) {
  try { return { accepted: publicKey.verify(digest, signature) }; }
  catch (error) { return { accepted: false, error: error.message }; }
}
const publishedKey = forge.pki.rsa.setPublicKey(
  new forge.jsbn.BigInteger(fixture.publicModulus, 16),
  new forge.jsbn.BigInteger(fixture.publicExponent)
);
const generated = generateKeyPairSync('rsa', { modulusLength: 1024 });
const privateKey = forge.pki.privateKeyFromPem(generated.privateKey.export({type:'pkcs1',format:'pem'}));
const publicKey = forge.pki.publicKeyFromPem(generated.publicKey.export({type:'pkcs1',format:'pem'}));
const asn1 = forge.asn1;
function signature(parameters, garbage) {
  const algorithm = [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
    asn1.oidToDer(forge.pki.oids.sha256).getBytes())];
  if (parameters) algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''));
  if (garbage) algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'unconsumed'));
  const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest)
  ]);
  return forge.pki.rsa.encrypt(asn1.toDer(info).getBytes(), privateKey, 0x01);
}
const signed = privateKey.sign(forge.md.sha256.create().update(fixture.message));
console.log(JSON.stringify({
  version: require('node-forge/package.json').version,
  publishedForgery: verify(publishedKey, forge.util.hexToBytes(fixture.forgedSignature)),
  extraWithNull: verify(publicKey, signature(true, true)),
  extraWithoutNull: verify(publicKey, signature(false, true)),
  validWithNull: verify(publicKey, signature(true, false)),
  validWithoutNull: verify(publicKey, signature(false, false)),
  ordinarySigning: verify(publicKey, signed)
}));
`;

interface Verification {
  accepted: boolean;
  error?: string;
}
interface InstalledResults {
  version: string;
  publishedForgery: Verification;
  extraWithNull: Verification;
  extraWithoutNull: Verification;
  validWithNull: Verification;
  validWithoutNull: Verification;
  ordinarySigning: Verification;
}

const installed = JSON.parse(
  execFileSync(process.execPath, ['-e', CHECK_INSTALLED_FORGE], {
    cwd: FRONTEND_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
) as InstalledResults;

describe('installed node-forge nested DigestAlgorithm validation', () => {
  it.each(['publishedForgery', 'extraWithNull', 'extraWithoutNull'] as const)(
    'rejects %s with default verification options',
    (key) => {
      expect(installed[key].accepted).toBe(false);
      expect(installed[key].error).toContain('valid RSASSA-PKCS1-v1_5 DigestInfo');
    },
  );

  it.each(['validWithNull', 'validWithoutNull', 'ordinarySigning'] as const)(
    'retains valid SHA-256 verification: %s',
    (key) => {
      expect(installed[key]).toEqual({ accepted: true });
    },
  );

  it('keeps the backport on the normal install path without extending its expiry', () => {
    const pkg = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'package.json'), 'utf8')) as {
      scripts: { postinstall: string };
    };
    const allowlist = JSON.parse(
      readFileSync(resolve(FRONTEND_ROOT, '.audit-allowlist.json'), 'utf8'),
    ) as { allow: { id: string; package: string; expires: string; issue: number }[] };
    expect(pkg.scripts.postinstall).toBe('patch-package');
    expect(installed.version).toBe('1.4.0');
    expect(allowlist.allow.find((entry) => entry.id === 'GHSA-86w9-cpqp-85rv')).toMatchObject({
      package: 'node-forge',
      expires: '2026-10-16',
      issue: 3023,
    });
  });
});
