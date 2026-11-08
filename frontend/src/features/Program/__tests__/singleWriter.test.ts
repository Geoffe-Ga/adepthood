import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';

/**
 * One seam moves the program anchor (#3097).
 *
 * The server owns the start date, and the client store is its mirror. If any
 * screen could call the PUT, or write the server-sourced anchor, on its own,
 * the Course, Journal, Practice, Map and habit reveal would drift apart again --
 * the two-anchor defect this issue closed. Only ``src/features/Program`` may do
 * either; the habit-derived fallback in ``habitManager`` is the one other
 * writer of the store's anchor, and only for the offline / no-server-row case.
 */

const SRC = path.resolve(__dirname, '..', '..', '..');
const PROGRAM_DIR = path.join(SRC, 'features', 'Program');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

const isSourceFile = (name: string): boolean =>
  /\.tsx?$/u.test(name) && !/\.(test|spec)\.tsx?$/u.test(name);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...walk(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const callersOf = (pattern: RegExp): string[] =>
  walk(SRC)
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file));

const outsideProgram = (files: string[]): string[] =>
  files.filter((file) => !path.join(SRC, file).startsWith(PROGRAM_DIR + path.sep));

describe('the program anchor has one writer (#3097)', () => {
  it('only src/features/Program calls PUT /stages/program-calendar', () => {
    expect(outsideProgram(callersOf(/\bstages\.setProgramStart\(/u))).toEqual([]);
  });

  it('only src/features/Program adopts the server anchor into the store', () => {
    expect(outsideProgram(callersOf(/\.adoptServerProgramStart\(/u))).toEqual([]);
  });

  it('only the habit-derived fallback writes a client-side anchor', () => {
    expect(callersOf(/\.setProgramStart(?:Date|Day)\(/u)).toEqual([
      path.join('features', 'Habits', 'services', 'habitManager.ts'),
    ]);
  });
});
