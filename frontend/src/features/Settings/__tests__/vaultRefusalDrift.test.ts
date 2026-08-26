/* eslint-env jest */
/* global describe, test, expect */
import { REFUSAL_SENTENCES } from '../VaultSettingsScreen';

import { backendPath, readBackendSource } from '@/testing/backendSource';

/**
 * The vault screen's refusal sentences, held to the codes the server can send.
 *
 * Both halves of this seam stay green through a drift on their own. The
 * router's tests assert the code it raises without knowing this screen exists;
 * the screen's tests build their own refusals from the map they are checking.
 * So a refusal code added on the backend renders as the generic "try again in a
 * moment" sentence with every suite on both sides passing -- which is exactly
 * how three codes once reached a person's screen with no words of their own.
 *
 * The vocabulary is therefore read back out of the Python that owns it: the two
 * defect enums, joined to the prefix and the key code the router builds its
 * refusals from. Nothing here restates a code, so a member added in Python
 * fails this on the day it is added.
 *
 * The reads go through `@/testing/backendSource`, and that import is what makes
 * backend CI run this file: adding a defect is a backend-only diff, and
 * `frontend-ci.yml` never sees one.
 */

/** Where the router spells the two halves of a refusal code. */
const ROUTER = ['src', 'routers', 'vault_config.py'];

/** Where the shape verdicts on any vault URL are named. */
const SHAPE_RULES = ['src', 'services', 'creek_vault_url.py'];

/** Where the destination verdicts on a user-supplied vault URL are named. */
const DESTINATION_RULES = ['src', 'services', 'creek_vault_url_user.py'];

/** One `NAME = "value"` member of an enum body, at class-body indentation. */
const ENUM_MEMBER = /^ {4}[A-Z][A-Z\d_]* = "([^"]+)"$/gm;

/**
 * The value of a module-level Python string constant.
 *
 * Throws rather than returning a default when the name is gone: a refusal
 * vocabulary derived from a constant that has been renamed would be silently
 * wrong, and a guard that derives the wrong vocabulary passes forever.
 *
 * @param segments - Path segments below `backend/`.
 * @param name - The constant's name.
 * @returns The string it is assigned.
 */
function pythonConstant(segments: string[], name: string): string {
  const match = new RegExp(`^${name} = "([^"]+)"$`, 'm').exec(readBackendSource(...segments));
  if (match === null) {
    throw new Error(
      `${backendPath(...segments)} declares no ${name} = "..."; the refusal codes are built somewhere else now.`,
    );
  }
  return String(match[1]);
}

/**
 * Every member value of one `enum.StrEnum` declared in a backend module.
 *
 * The body is cut at the first line starting in column zero, so a constant
 * declared after the class cannot be counted as one of its members.
 *
 * @param segments - Path segments below `backend/`.
 * @param className - The enum class to read.
 * @returns The declared values, in declaration order.
 */
function enumMemberValues(segments: string[], className: string): string[] {
  const source = readBackendSource(...segments);
  const declaration = new RegExp(`^class ${className}\\(enum\\.StrEnum\\):$`, 'm').exec(source);
  if (declaration === null) {
    throw new Error(
      `${backendPath(...segments)} declares no "class ${className}(enum.StrEnum)"; the defect vocabulary has moved.`,
    );
  }
  const body = source.slice(declaration.index + declaration[0].length).split(/^\S/m)[0] ?? '';
  const values = [...body.matchAll(ENUM_MEMBER)].map((member) => String(member[1]));
  if (values.length === 0) {
    throw new Error(
      `${backendPath(...segments)} declares ${className} with no members this guard can read; the parse has drifted from the source.`,
    );
  }
  return values;
}

/** Every refusal detail `PUT /vault/connection` can answer a 422 with. */
function serverRefusalCodes(): string[] {
  const prefix = pythonConstant(ROUTER, '_URL_REFUSED_PREFIX');
  const urlDefects = [
    ...enumMemberValues(SHAPE_RULES, 'VaultUrlDefect'),
    ...enumMemberValues(DESTINATION_RULES, 'UserVaultUrlDefect'),
  ];
  return [
    ...urlDefects.map((defect) => `${prefix}${defect}`),
    pythonConstant(ROUTER, '_KEY_REFUSED'),
  ];
}

describe('the refusal vocabulary this guard derives from the backend', () => {
  test('finds every shape defect the shared classifier can report', () => {
    expect(enumMemberValues(SHAPE_RULES, 'VaultUrlDefect').length).toBeGreaterThan(0);
  });

  test('finds every destination defect the user-URL guard can report', () => {
    expect(enumMemberValues(DESTINATION_RULES, 'UserVaultUrlDefect').length).toBeGreaterThan(0);
  });

  test('names the prefix and the key code the router builds refusals from', () => {
    expect(pythonConstant(ROUTER, '_URL_REFUSED_PREFIX')).not.toBe('');
    expect(pythonConstant(ROUTER, '_KEY_REFUSED')).not.toBe('');
  });

  test('says so, naming the file, when an enum it reads is gone', () => {
    expect(() => enumMemberValues(SHAPE_RULES, 'NoSuchDefect')).toThrow(
      backendPath(...SHAPE_RULES),
    );
  });

  test('says so, naming the file, when a router constant is gone', () => {
    expect(() => pythonConstant(ROUTER, '_NO_SUCH_CONSTANT')).toThrow(backendPath(...ROUTER));
  });
});

describe('the vault screen, against the refusals the server can send', () => {
  test('has a sentence for every code the endpoint can refuse with', () => {
    for (const code of serverRefusalCodes()) {
      expect([...REFUSAL_SENTENCES.keys()]).toContain(code);
    }
  });

  test('keeps no sentence for a code the endpoint can no longer send', () => {
    expect([...REFUSAL_SENTENCES.keys()].sort()).toEqual([...serverRefusalCodes()].sort());
  });

  test('gives each refusal words rather than an empty line', () => {
    const wordless = [...REFUSAL_SENTENCES].filter(
      ([, sentence]) => typeof sentence !== 'string' || sentence.trim() === '',
    );

    expect(wordless.map(([code]) => code)).toEqual([]);
  });

  test('tells the refusals apart, giving no two codes the same sentence', () => {
    const sentences = [...REFUSAL_SENTENCES.values()];

    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
