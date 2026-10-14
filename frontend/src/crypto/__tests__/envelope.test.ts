import { describe, expect, it, jest } from '@jest/globals';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  ENVELOPE_FORMAT_V1,
  ENVELOPE_V1_LAYOUT,
  encodeAad,
  openObject,
  sealObject,
  type ObjectBinding,
  type ObjectExpectation,
} from '../envelope';
import { EnvelopeError, type EnvelopeFailure } from '../errors';

const KEY_BYTES = 32;
const OWNER_A_KEY = new Uint8Array(KEY_BYTES).fill(0x11);
const OWNER_B_KEY = new Uint8Array(KEY_BYTES).fill(0x22);
const PLAINTEXT_TEXT = 'canary: the heron stands in the shallows at dawn';
const PLAINTEXT = new TextEncoder().encode(PLAINTEXT_TEXT);
const NONCE_SAMPLE_SIZE = 2000;

const BINDING: ObjectBinding = {
  ownerId: 'owner-a',
  objectType: 'journal_entry',
  objectId: 'entry-42',
  objectVersion: 3,
};

const EXPECT: ObjectExpectation = {
  ownerId: BINDING.ownerId,
  objectType: BINDING.objectType,
  objectId: BINDING.objectId,
  minVersion: BINDING.objectVersion,
};

function sealed(): Uint8Array {
  return sealObject(OWNER_A_KEY, PLAINTEXT, BINDING);
}

function failureOf(action: () => unknown): EnvelopeError {
  try {
    action();
  } catch (error) {
    if (error instanceof EnvelopeError) {
      return error;
    }
    throw new Error(`expected an EnvelopeError, got ${String(error)}`);
  }
  throw new Error('expected the action to fail closed, but it succeeded');
}

function expectFailure(action: () => unknown, code: EnvelopeFailure): EnvelopeError {
  const error = failureOf(action);
  expect(error.code).toBe(code);
  return error;
}

function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('envelope v1: round trip and layout', () => {
  it('opens what it sealed and reports the bound version', () => {
    const opened = openObject(OWNER_A_KEY, sealed(), EXPECT);

    expect(new TextDecoder().decode(opened.plaintext)).toBe(PLAINTEXT_TEXT);
    expect(opened.objectVersion).toBe(BINDING.objectVersion);
  });

  it('accepts a bound version above the expected minimum', () => {
    const opened = openObject(OWNER_A_KEY, sealed(), { ...EXPECT, minVersion: 1 });

    expect(opened.objectVersion).toBe(BINDING.objectVersion);
  });

  it('round-trips an empty plaintext', () => {
    const envelope = sealObject(OWNER_A_KEY, new Uint8Array(0), BINDING);

    expect(envelope).toHaveLength(ENVELOPE_V1_LAYOUT.minimumLength);
    expect(openObject(OWNER_A_KEY, envelope, EXPECT).plaintext).toHaveLength(0);
  });

  it('lays out format byte, u64 version, 24-byte nonce, then ciphertext and 16-byte tag', () => {
    const envelope = sealed();
    const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);

    expect(ENVELOPE_V1_LAYOUT).toEqual({
      formatOffset: 0,
      versionOffset: 1,
      nonceOffset: 9,
      ciphertextOffset: 33,
      nonceBytes: 24,
      tagBytes: 16,
      minimumLength: 49,
    });
    expect(envelope[0]).toBe(ENVELOPE_FORMAT_V1);
    expect(view.getBigUint64(ENVELOPE_V1_LAYOUT.versionOffset)).toBe(BigInt(BINDING.objectVersion));
    expect(envelope).toHaveLength(ENVELOPE_V1_LAYOUT.minimumLength + PLAINTEXT.length);
  });

  it('never carries the plaintext in the clear', () => {
    const hex = bytesToHex(sealed());

    expect(hex).not.toContain(bytesToHex(PLAINTEXT.subarray(0, 8)));
  });

  it('draws a fresh nonce for every seal', () => {
    const nonces = new Set<string>();
    const { nonceOffset, ciphertextOffset } = ENVELOPE_V1_LAYOUT;
    for (let i = 0; i < NONCE_SAMPLE_SIZE; i += 1) {
      nonces.add(bytesToHex(sealed().subarray(nonceOffset, ciphertextOffset)));
    }

    expect(nonces.size).toBe(NONCE_SAMPLE_SIZE);
  });
});

describe('envelope v1: canonical AAD', () => {
  it('length-prefixes each field so shifted boundaries never collide', () => {
    const left = encodeAad('object', ['ab', 'c'], 1);
    const right = encodeAad('object', ['a', 'bc'], 1);

    expect(bytesToHex(left)).not.toBe(bytesToHex(right));
  });

  it('encodes label, format, domain, field count, fields and version exactly', () => {
    const aad = encodeAad('d', ['x', 'yz'], 7);

    expect(bytesToHex(aad)).toBe(
      [
        '00000012',
        bytesToHex(new TextEncoder().encode('adepthood.envelope')),
        '01',
        '00000001',
        '64',
        '00000002',
        '00000001',
        '78',
        '00000002',
        '797a',
        '0000000000000007',
      ].join(''),
    );
  });

  it('accepts raw byte fields alongside strings', () => {
    const fromBytes = encodeAad('d', [new Uint8Array([0x78])], 0);
    const fromString = encodeAad('d', ['x'], 0);

    expect(bytesToHex(fromBytes)).toBe(bytesToHex(fromString));
  });
});

describe('envelope v1: fails closed', () => {
  it('rejects a tampered ciphertext byte', () => {
    const envelope = flipByte(sealed(), ENVELOPE_V1_LAYOUT.ciphertextOffset);

    expectFailure(() => openObject(OWNER_A_KEY, envelope, EXPECT), 'authentication_failed');
  });

  it('rejects a tampered tag byte', () => {
    const envelope = sealed();

    expectFailure(
      () => openObject(OWNER_A_KEY, flipByte(envelope, envelope.length - 1), EXPECT),
      'authentication_failed',
    );
  });

  it('rejects a tampered nonce byte', () => {
    const envelope = flipByte(sealed(), ENVELOPE_V1_LAYOUT.nonceOffset);

    expectFailure(() => openObject(OWNER_A_KEY, envelope, EXPECT), 'authentication_failed');
  });

  it.each([
    ['owner', { ownerId: 'owner-b' }],
    ['object type', { objectType: 'reflection' }],
    ['object id', { objectId: 'entry-43' }],
  ])('rejects a different %s in the AAD', (_field, override) => {
    expectFailure(
      () => openObject(OWNER_A_KEY, sealed(), { ...EXPECT, ...override }),
      'authentication_failed',
    );
  });

  it('rejects a version raised in the header to slip past the rollback check', () => {
    const envelope = sealed();
    const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    view.setBigUint64(ENVELOPE_V1_LAYOUT.versionOffset, BigInt(BINDING.objectVersion + 1));

    expectFailure(
      () => openObject(OWNER_A_KEY, envelope, { ...EXPECT, minVersion: BINDING.objectVersion + 1 }),
      'authentication_failed',
    );
  });

  it('refuses an envelope whose bound version is lower than expected (replay)', () => {
    expectFailure(
      () => openObject(OWNER_A_KEY, sealed(), { ...EXPECT, minVersion: BINDING.objectVersion + 1 }),
      'rollback',
    );
  });

  it('refuses a swapped row: a valid envelope for another object', () => {
    const otherRow = sealObject(OWNER_A_KEY, PLAINTEXT, { ...BINDING, objectId: 'entry-7' });

    expectFailure(() => openObject(OWNER_A_KEY, otherRow, EXPECT), 'authentication_failed');
  });

  it("refuses a cross-account envelope: another owner's key and binding", () => {
    const foreign = sealObject(OWNER_B_KEY, PLAINTEXT, { ...BINDING, ownerId: 'owner-b' });

    expectFailure(() => openObject(OWNER_A_KEY, foreign, EXPECT), 'authentication_failed');
    expectFailure(
      () => openObject(OWNER_A_KEY, foreign, { ...EXPECT, ownerId: 'owner-b' }),
      'authentication_failed',
    );
  });

  it('refuses the right envelope under the wrong key', () => {
    expectFailure(() => openObject(OWNER_B_KEY, sealed(), EXPECT), 'authentication_failed');
  });

  it('refuses a truncated nonce as malformed', () => {
    const truncated = sealed().subarray(0, ENVELOPE_V1_LAYOUT.nonceOffset + 10);

    expectFailure(() => openObject(OWNER_A_KEY, truncated, EXPECT), 'malformed');
  });

  it('refuses a truncated tag', () => {
    const envelope = sealed();

    expectFailure(
      () => openObject(OWNER_A_KEY, envelope.subarray(0, envelope.length - 1), EXPECT),
      'authentication_failed',
    );
  });

  it('refuses an envelope too short to hold a tag as malformed', () => {
    const empty = sealObject(OWNER_A_KEY, new Uint8Array(0), BINDING);

    expectFailure(
      () => openObject(OWNER_A_KEY, empty.subarray(0, empty.length - 1), EXPECT),
      'malformed',
    );
  });

  it.each([
    ['downgraded', 0],
    ['unknown future', ENVELOPE_FORMAT_V1 + 1],
  ])('refuses a %s format version', (_label, format) => {
    const envelope = sealed();
    envelope[ENVELOPE_V1_LAYOUT.formatOffset] = format;

    expectFailure(() => openObject(OWNER_A_KEY, envelope, EXPECT), 'unsupported_format');
  });

  it('refuses an empty buffer as malformed', () => {
    expectFailure(() => openObject(OWNER_A_KEY, new Uint8Array(0), EXPECT), 'malformed');
  });

  it('refuses a header version beyond the safe integer range as malformed', () => {
    const envelope = sealed();
    const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    view.setBigUint64(ENVELOPE_V1_LAYOUT.versionOffset, 2n ** 64n - 1n);

    expectFailure(() => openObject(OWNER_A_KEY, envelope, EXPECT), 'malformed');
  });
});

describe('envelope v1: rejects bad inputs before sealing', () => {
  it.each([
    ['a short key', () => sealObject(new Uint8Array(KEY_BYTES - 1), PLAINTEXT, BINDING)],
    [
      'a negative version',
      () => sealObject(OWNER_A_KEY, PLAINTEXT, { ...BINDING, objectVersion: -1 }),
    ],
    [
      'a fractional version',
      () => sealObject(OWNER_A_KEY, PLAINTEXT, { ...BINDING, objectVersion: 1.5 }),
    ],
    [
      'an unsafe version',
      () => sealObject(OWNER_A_KEY, PLAINTEXT, { ...BINDING, objectVersion: 2 ** 53 }),
    ],
    ['an empty owner id', () => sealObject(OWNER_A_KEY, PLAINTEXT, { ...BINDING, ownerId: '' })],
    ['an empty object id', () => sealObject(OWNER_A_KEY, PLAINTEXT, { ...BINDING, objectId: '' })],
    ['a short key on open', () => openObject(new Uint8Array(1), sealed(), EXPECT)],
    [
      'a negative minimum on open',
      () => openObject(OWNER_A_KEY, sealed(), { ...EXPECT, minVersion: -1 }),
    ],
  ])('refuses %s', (_label, action) => {
    expectFailure(action, 'invalid_input');
  });
});

describe('envelope v1: errors carry no content', () => {
  it('puts no plaintext, key or binding into the error or the console', () => {
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );
    const envelope = flipByte(sealed(), ENVELOPE_V1_LAYOUT.ciphertextOffset);

    const error = expectFailure(
      () => openObject(OWNER_A_KEY, envelope, EXPECT),
      'authentication_failed',
    );
    const rendered = [error.message, String(error), error.stack ?? '', JSON.stringify(error)].join(
      '\n',
    );

    for (const secret of [
      PLAINTEXT_TEXT,
      bytesToHex(OWNER_A_KEY),
      BINDING.ownerId,
      BINDING.objectId,
    ]) {
      expect(rendered).not.toContain(secret);
    }
    expect(error.cause).toBeUndefined();
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
