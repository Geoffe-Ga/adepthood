import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * Enrolment in user-held keys stays unreachable (ADR 0009 phase (b), B13).
 *
 * `src/crypto/` holds the client-side envelope and key wrapping, shipped as
 * code and tests only: the independent review ADR 0009 requires before any real
 * account enrols has not happened, so nothing the app runs may reach it. This
 * guard parses every production module under `src/` and fails if any of them
 * imports the crypto module (by relative path, the `@/` alias, or the bare
 * `crypto/...` path Jest's `moduleDirectories` would resolve), or imports the
 * underlying primitive libraries directly to route around it. A later,
 * owner-gated slice that wires enrolment must change this test on purpose.
 */

const SRC = path.resolve(__dirname, '..', '..');
const CRYPTO_DIR = path.join(SRC, 'crypto');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);
const PRIMITIVE_PACKAGES = /^@(noble|scure)\//u;
const BARE_CRYPTO_PATH = /^crypto\//u;
const ALIAS_PREFIX = '@/';
// The app has hundreds of production modules; a walk that finds a handful has
// gone wrong (wrong root, over-broad ignore) and would pass vacuously.
const MINIMUM_SCANNED_MODULES = 200;
const EXPECTED_CRYPTO_MODULES = [
  'envelope.ts',
  'errors.ts',
  'kdf.ts',
  'keyHierarchy.ts',
  'recoveryPhrase.ts',
];

const isProductionSource = (name: string): boolean =>
  /\.tsx?$/u.test(name) && !/\.(test|spec)\.tsx?$/u.test(name) && !name.endsWith('.d.ts');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...walk(full));
    } else if (entry.isFile() && isProductionSource(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function isInside(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}${path.sep}`);
}

function stringArgument(node: ts.CallExpression): string | undefined {
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
}

function callSpecifier(node: ts.CallExpression): string | undefined {
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  return isDynamicImport || isRequire ? stringArgument(node) : undefined;
}

function nodeSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const ref = node.moduleReference.expression;
    return ts.isStringLiteralLike(ref) ? ref.text : undefined;
  }
  return ts.isCallExpression(node) ? callSpecifier(node) : undefined;
}

/** Every module specifier a source text imports, re-exports, requires or dynamically imports. */
function moduleSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = nodeSpecifier(node);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function reachesCrypto(fromFile: string, specifier: string): boolean {
  if (PRIMITIVE_PACKAGES.test(specifier) || BARE_CRYPTO_PATH.test(specifier)) {
    return true;
  }
  if (specifier.startsWith(ALIAS_PREFIX)) {
    return isInside(path.join(SRC, specifier.slice(ALIAS_PREFIX.length)), CRYPTO_DIR);
  }
  if (specifier.startsWith('.')) {
    return isInside(path.resolve(path.dirname(fromFile), specifier), CRYPTO_DIR);
  }
  return false;
}

/** `file -> specifier` for each import that reaches the crypto module or its primitives. */
function cryptoImports(fileName: string, text: string): string[] {
  return moduleSpecifiers(fileName, text)
    .filter((specifier) => reachesCrypto(fileName, specifier))
    .map((specifier) => `${path.relative(SRC, fileName)} -> ${specifier}`);
}

describe('the client crypto module is unreachable from the app (B13 phase (b))', () => {
  const productionModules = walk(SRC).filter((file) => !isInside(file, CRYPTO_DIR));

  it('scans the whole production tree', () => {
    expect(productionModules.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_MODULES);
    expect(productionModules).toContain(path.join(SRC, 'App.tsx'));
  });

  it('still has the crypto modules it is guarding', () => {
    const present = fs.readdirSync(CRYPTO_DIR).filter(isProductionSource).sort();

    expect(present).toEqual(EXPECTED_CRYPTO_MODULES);
  });

  it('no screen, store, API module or route imports the crypto module or its primitives', () => {
    const offenders = productionModules.flatMap((file) =>
      cryptoImports(file, fs.readFileSync(file, 'utf-8')),
    );

    expect(offenders).toEqual([]);
  });

  it('the crypto module itself exports no enrolment flow', () => {
    const exported = fs
      .readdirSync(CRYPTO_DIR)
      .filter(isProductionSource)
      .flatMap((name) => {
        const text = fs.readFileSync(path.join(CRYPTO_DIR, name), 'utf-8');
        return [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gu)].map(
          (match) => match[1] ?? '',
        );
      });

    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((name) => /enrol|enroll|onboard/iu.test(name))).toEqual([]);
  });

  describe('the detector itself', () => {
    const screen = path.join(SRC, 'features', 'Journal', 'Probe.tsx');

    it.each([
      ['a relative import', "import { sealObject } from '../../crypto/envelope';"],
      ['the @/ alias', "import { sealObject } from '@/crypto/envelope';"],
      ['the directory index', "import * as c from '@/crypto';"],
      ['a bare moduleDirectories path', "import { sealObject } from 'crypto/envelope';"],
      ['a re-export', "export { sealObject } from '../../crypto/envelope';"],
      ['a type-only import', "import type { ObjectBinding } from '../../crypto/envelope';"],
      ['a dynamic import', "const m = import('../../crypto/keyHierarchy');"],
      ['a require', "const m = require('../../crypto/kdf');"],
      ['an import-equals', "import m = require('../../crypto/kdf');"],
      [
        'the AEAD primitive directly',
        "import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';",
      ],
      ['the KDF primitive directly', "import { argon2id } from '@noble/hashes/argon2.js';"],
      ['the phrase library directly', "import { generateMnemonic } from '@scure/bip39';"],
    ])('flags %s', (_label, text) => {
      expect(cryptoImports(screen, text)).toHaveLength(1);
    });

    it.each([
      ['a sibling with a crypto-like name', "import { x } from '../../cryptoish/thing';"],
      ["Node's built-in crypto", "import { randomUUID } from 'node:crypto';"],
      ['an unrelated package', "import { create } from 'zustand';"],
    ])('does not flag %s', (_label, text) => {
      expect(cryptoImports(screen, text)).toEqual([]);
    });
  });
});
