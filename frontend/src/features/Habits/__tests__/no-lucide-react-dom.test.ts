import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from '@jest/globals';

/**
 * Guard against the §5.2 "Critical" render bug: importing icons from the
 * DOM/web package `lucide-react` instead of `lucide-react-native`. The web
 * package returns SVG DOM nodes React Native cannot mount, so the screen
 * renders nothing or crashes on a real device while still "demoing" on web.
 *
 * This test walks every app source file under `frontend/src` and fails on a
 * `from 'lucide-react'` (non-native) import, so the mistake cannot silently
 * recur. It is backed by an ESLint `no-restricted-imports` rule as well.
 */

// __dirname -> frontend/src/features/Habits/__tests__; climb to frontend/src.
const SRC_ROOT = path.join(__dirname, '..', '..', '..');

// Matches `from 'lucide-react'` / `from "lucide-react"` and
// `require('lucide-react')`, but NOT `lucide-react-native` (the next char
// after the package name is `-`, not a closing quote).
const DOM_LUCIDE_IMPORT = /['"]lucide-react['"]/;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('lucide icon imports', () => {
  it('never imports the DOM package lucide-react in app source', () => {
    const offenders = collectSourceFiles(SRC_ROOT)
      // Skip this guard's own source — it deliberately mentions the string.
      .filter((file) => file !== __filename)
      .filter((file) => DOM_LUCIDE_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
