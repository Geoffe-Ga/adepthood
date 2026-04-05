import * as fs from 'fs';
import * as path from 'path';

const DEAD_FILES = [
  'src/features/Habits/HabitCard.tsx',
  'src/features/Habits/HabitCard.styles.ts',
  'src/styles/colors.ts',
  'src/components/Button/Button.tsx',
  'src/components/Button/Button.styles.ts',
];

const ROOT = path.resolve(__dirname, '..', '..');

describe('phase-2-04: no dead/empty files', () => {
  it.each(DEAD_FILES)('%s should not exist', (relPath) => {
    const fullPath = path.join(ROOT, relPath);
    expect(fs.existsSync(fullPath)).toBe(false);
  });

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
