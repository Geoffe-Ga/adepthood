/**
 * Every Practice component that animates honours the OS "Reduce Motion"
 * setting (#3072 AC5). The metronome pulse shipped without it — 1 800 pulses
 * in a 30-minute sit — so this scans for the defect class rather than the one
 * instance: a source file that starts an `Animated` motion must also consult
 * `useReducedMotion`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';

const PRACTICE_DIR = path.resolve(__dirname, '..');
const ANIMATION_CALL = /Animated\.(timing|sequence|loop|spring|decay|parallel|stagger)\(/;
const REDUCED_MOTION_GUARD = /useReducedMotion(Setting)?\(/;

/** Every non-test `.tsx` source under `features/Practice`. */
function practiceSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : practiceSources(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

const animated = practiceSources(PRACTICE_DIR).filter((file) =>
  ANIMATION_CALL.test(fs.readFileSync(file, 'utf8')),
);

describe('Practice motion honours reduced motion', () => {
  it('finds the animated sources it guards', () => {
    expect(animated.map((file) => path.basename(file))).toContain('MetronomeView.tsx');
  });

  it.each(animated.map((file) => [path.relative(PRACTICE_DIR, file), file]))(
    '%s consults useReducedMotion',
    (_relative, file) => {
      expect(fs.readFileSync(file, 'utf8')).toMatch(REDUCED_MOTION_GUARD);
    },
  );
});
