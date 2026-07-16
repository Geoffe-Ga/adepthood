import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';

const ROOT = path.resolve(__dirname, '..', '..');

describe('phase-2-04: no dead/empty files', () => {
  it('should have no empty .ts/.tsx files in src/', () => {
    const findEmpty = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
          results.push(...findEmpty(full));
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf-8').trim();
          if (content === '') {
            results.push(path.relative(ROOT, full));
          }
        }
      }
      return results;
    };

    const emptyFiles = findEmpty(path.join(ROOT, 'src'));
    expect(emptyFiles).toEqual([]);
  });
});
