/* eslint-env jest */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { parseJournalMarkdown, serializeJournalMarkdown } from '../journalMarkdown';

/**
 * The one module the editor and the renderer both enter the model through.
 *
 * The rest of the model is DISCOVERED from here by following relative imports,
 * not listed: a hand-maintained list is closed under additions but not
 * removals, so deleting an entry would silently shrink what is checked, and a
 * module added for a later issue would go unchecked until someone remembered
 * to append it.
 */
const MODEL_ROOT = 'journalMarkdown.ts';

/** Anything importing these, at any depth, cannot be used before a renderer mounts. */
const HOST_MODULES = /^react(-native)?$/u;

function moduleSource(name: string): string {
  return readFileSync(join(__dirname, '..', name), 'utf8');
}

/**
 * Every module specifier one module names, in any of the four spellings a
 * drifting edit might use: `from '...'`, `from "..."`, a bare side-effect
 * `import '...'`, and `require('...')`.
 */
function specifiersOf(source: string): string[] {
  const patterns = [
    /\b(?:from|import)\s+(['"])([^'"]+)\1/gu,
    /\brequire\(\s*(['"])([^'"]+)\1\s*\)/gu,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[2]!));
}

/** The file a relative specifier names, or null when it resolves to nothing. */
function resolveSibling(specifier: string): string | null {
  const bare = specifier.slice('./'.length);
  return (
    [bare, `${bare}.ts`, `${bare}.tsx`].find((candidate) =>
      existsSync(join(__dirname, '..', candidate)),
    ) ?? null
  );
}

type ImportEdge = [from: string, specifier: string];

/** Every specifier one module names, paired with the module that named it. */
function edgesFrom(name: string): ImportEdge[] {
  return specifiersOf(moduleSource(name)).map((specifier) => [name, specifier]);
}

/** The sibling files those edges reach; a non-relative specifier reaches none. */
function siblingsOf(edges: ImportEdge[]): string[] {
  return edges
    .map(([, specifier]) => (specifier.startsWith('./') ? resolveSibling(specifier) : null))
    .filter((name): name is string => name != null);
}

/**
 * Pure editor modules that sit BESIDE the facade rather than under it -- the
 * edit operations the text field calls. They are found by name, not listed, for
 * the same reason the model is walked rather than declared: a new
 * ``markdownSomething.ts`` is checked the moment it exists. View helpers that
 * may import React Native are therefore never named ``markdown*`` or
 * ``journalMarkdown*``.
 */
const EDITOR_ROOT = /^(?:journalMarkdown|markdown)\w*\.ts$/u;

function editorRoots(): string[] {
  return readdirSync(join(__dirname, '..'))
    .filter((name) => EDITOR_ROOT.test(name))
    .sort();
}

/** The transitive closure of relative imports from ``roots``. */
function walkModel(roots: string[] = [MODEL_ROOT]): { modules: string[]; edges: ImportEdge[] } {
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const own = edgesFrom(name);
    edges.push(...own);
    queue.push(...siblingsOf(own));
  }
  return { modules: [...seen].sort(), edges };
}

const MODEL = walkModel();

describe('the Markdown model stays free of the renderer', () => {
  it('is exactly the six modules reachable from the facade', () => {
    // Discovered, not declared: a seventh module is checked the moment it is
    // imported, and a module dropped from the model is visible here too.
    expect(MODEL.modules).toEqual([
      'codePoints.ts',
      'journalMarkdown.ts',
      'journalMarkdownCaret.ts',
      'journalMarkdownInline.ts',
      'journalMarkdownLines.ts',
      'journalMarkdownTypes.ts',
    ]);
  });

  it.each(MODEL.modules)('%s imports neither React nor React Native', (name) => {
    expect(specifiersOf(moduleSource(name)).filter((s) => HOST_MODULES.test(s))).toEqual([]);
  });

  it('reaches react-native through no chain of relative imports at all', () => {
    // The assertion the file is named for. Checking only the model's OWN
    // import lines would pass a sibling that itself pulls in react-native --
    // `readingSurfaceStyles.ts` next door does exactly that.
    const host = MODEL.edges.filter(([, specifier]) => HOST_MODULES.test(specifier));
    expect(host).toEqual([]);
  });

  it.each(MODEL.modules)('%s imports only from inside this model', (name) => {
    for (const specifier of specifiersOf(moduleSource(name))) {
      expect(specifier.startsWith('./')).toBe(true);
    }
  });

  it.each(MODEL.modules)('%s names no sibling that does not exist', (name) => {
    for (const specifier of specifiersOf(moduleSource(name))) {
      expect(resolveSibling(specifier)).not.toBeNull();
    }
  });

  it('discovers every pure editor module by name, the Return handler among them', () => {
    // Not vacuous: the pattern must actually find the editor half of the model.
    expect(editorRoots()).toEqual(
      expect.arrayContaining([
        'journalMarkdown.ts',
        'markdownCommands.ts',
        'markdownEditing.ts',
        'markdownIndent.ts',
        'markdownInlineToggle.ts',
        'markdownMirror.ts',
      ]),
    );
    expect(editorRoots().every((name) => !name.endsWith('.test.ts'))).toBe(true);
  });

  it('reaches no host module from any pure editor module, at any depth', () => {
    const editor = walkModel(editorRoots());
    expect(editor.edges.filter(([, specifier]) => HOST_MODULES.test(specifier))).toEqual([]);
    for (const name of editor.modules) {
      for (const specifier of specifiersOf(moduleSource(name))) {
        expect(specifier.startsWith('./')).toBe(true);
      }
    }
  });

  it('parses and serializes with no host environment at all', () => {
    // Edit mode and read mode share this module, and the editor runs before any
    // renderer is mounted; a stray React import would make it unusable there.
    expect(serializeJournalMarkdown(parseJournalMarkdown('- one\n> two'))).toBe('- one\n> two');
  });
});
