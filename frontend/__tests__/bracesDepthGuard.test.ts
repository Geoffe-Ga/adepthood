import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const FRONTEND_ROOT = resolve(__dirname, '..');
const DEPTH_MESSAGE = 'AST nesting depth exceeds the maximum of 100';

/** Run the real installed libraries outside Jest's React Native module mocks. */
const INSTALLED_CHECK = `
const braces = require('braces');
const micromatch = require('micromatch');
function result(operation) {
  try { return { value: operation() }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}
function ast(depth) {
  let node = { type: 'root', nodes: [] };
  for (let i = 0; i < depth; i++) node = { type: 'root', nodes: [node] };
  return node;
}
const deep = '{'.repeat(4000) + 'x' + '}'.repeat(4000);
const options = { maxLength: Infinity, maxDepth: Infinity };
const strings = {};
for (const op of ['default', 'parse', 'compile', 'expand', 'stringify']) {
  strings[op] = result(() => {
    if (op === 'default') braces(deep, options); else braces[op](deep, options);
    return 'accepted';
  });
}
const walkers = {};
for (const op of ['compile', 'expand', 'stringify']) {
  const shared = { type: 'text', value: 'x' };
  walkers[op] = {
    deep: result(() => braces[op](ast(4000), options)),
    boundary: result(() => braces[op](ast(100))),
    excessive: result(() => braces[op](ast(101))),
    shared: result(() => braces[op]({ type: 'root', nodes: [shared, shared] }))
  };
}
const parentheses = result(() => { braces.parse('('.repeat(4000) + 'x' + ')'.repeat(4000), options); return 'accepted'; });
const unclosedBraces = result(() => { braces.parse('{'.repeat(4000) + 'x'); return 'accepted'; });
const unclosedParens = result(() => { braces.parse('('.repeat(4000) + 'x'); return 'accepted'; });
// Valid comma alternatives avoid invalid-brace cleanup invoking stringify.
const alternations = depth => '{a,'.repeat(depth) + 'x' + '}'.repeat(depth);
const parserBoundary = result(() => braces.parse(alternations(100), options).type);
const parserExcessive = result(() => braces.parse(alternations(101), options).type);
const facades = {};
for (const op of ['braces', 'braceExpand', 'parse']) {
  facades[op] = result(() => { micromatch[op](deep, options); return 'accepted'; });
}
const below = '{'.repeat(99) + 'x' + '}'.repeat(99);
console.log(JSON.stringify({
  version: require('braces/package.json').version,
  strings, walkers, parentheses, unclosedBraces, unclosedParens,
  parserBoundary, parserExcessive, facades,
  ordinary: {
    compiled: braces.compile('app/{reading,writing}/**/*.{js,jsx}'),
    range: braces.expand('page-{1..3}.js'),
    escaped: braces.expand('a\\\\{b,c\\\\}'),
    ast: braces.compile(braces.parse('a/{b,c}/d')),
    belowStringify: braces.stringify(below),
    belowExpand: braces.expand(below),
    facade: micromatch.braces('src/{reading,writing}/**/*.tsx'),
    facadeExpand: micromatch.braceExpand('page-{1..3}.js'),
    matched: micromatch(['src/a.test.ts', 'src/a.ts', 'src/a.test.js'], '**/*.test.{ts,tsx}'),
    parsed: micromatch.parse('src/{reading,writing}/**/*.tsx').length
  }
}));
`;

interface Outcome {
  value?: unknown;
  error?: { name: string; message: string };
}
interface InstalledResults {
  version: string;
  strings: Record<string, Outcome>;
  walkers: Record<
    string,
    { deep: Outcome; boundary: Outcome; excessive: Outcome; shared: Outcome }
  >;
  parentheses: Outcome;
  unclosedBraces: Outcome;
  unclosedParens: Outcome;
  parserBoundary: Outcome;
  parserExcessive: Outcome;
  facades: Record<string, Outcome>;
  ordinary: Record<string, unknown>;
}

const installed = JSON.parse(
  execFileSync(process.execPath, ['--stack_size=512', '-e', INSTALLED_CHECK], {
    cwd: FRONTEND_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
) as InstalledResults;

const controlledError = { error: { name: 'SyntaxError', message: DEPTH_MESSAGE } };

describe('installed braces mandatory recursion limit', () => {
  it.each(['default', 'parse', 'compile', 'expand', 'stringify'])(
    'rejects deeply nested strings through %s before stack exhaustion',
    (operation) => expect(installed.strings[operation]).toEqual(controlledError),
  );

  it.each(['compile', 'expand', 'stringify'])(
    'bounds direct AST traversal in %s without rejecting repeated shared nodes',
    (operation) => {
      expect(installed.walkers[operation]).toEqual({
        deep: controlledError,
        boundary: { value: operation === 'expand' ? [] : '' },
        excessive: controlledError,
        shared: { value: operation === 'expand' ? ['xx'] : 'xx' },
      });
    },
  );

  it('bounds parentheses and malformed unclosed containers before cleanup', () => {
    expect(installed.parentheses).toEqual(controlledError);
    expect(installed.unclosedBraces).toEqual(controlledError);
    expect(installed.unclosedParens).toEqual(controlledError);
  });

  it('accepts 100 valid nested alternatives and rejects 101 in the parser itself', () => {
    expect(installed.parserBoundary).toEqual({ value: 'root' });
    expect(installed.parserExcessive).toEqual(controlledError);
  });

  it.each(['braces', 'braceExpand', 'parse'])(
    'contains the installed micromatch %s facade',
    (operation) => expect(installed.facades[operation]).toEqual(controlledError),
  );

  it('preserves ordinary patterns, parsed ASTs and supported below-limit nesting', () => {
    const below = '{'.repeat(99) + 'x' + '}'.repeat(99);
    expect(installed.version).toBe('3.0.3');
    expect(installed.ordinary).toEqual({
      compiled: 'app/(reading|writing)/**/*.(js|jsx)',
      range: ['page-1.js', 'page-2.js', 'page-3.js'],
      escaped: ['a{b,c}'],
      ast: 'a/(b|c)/d',
      belowStringify: below,
      belowExpand: [below],
      facade: ['src/(reading|writing)/**/*.tsx'],
      facadeExpand: ['page-1.js', 'page-2.js', 'page-3.js'],
      matched: ['src/a.test.ts'],
      parsed: 1,
    });
  });
});
