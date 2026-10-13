import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

/**
 * zod 4 compiles object schemas with `new Function` unless told not to, and
 * probes for that ability with `new Function("")` the moment an object schema
 * is built. The enforced CSP's `script-src 'self'` refuses eval, so in the
 * browser the probe throws (zod falls back) and also reports a
 * `securitypolicyviolation` on every page load -- noise that would hide a real
 * injection. `src/zodJitless.ts` turns the JIT off, and it only helps if it
 * runs before any schema is constructed: hence it comes straight after
 * reanimated, ahead of every import that reaches app code.
 */
describe('zod runs jitless under the enforced CSP', () => {
  it('switches the zod JIT off when imported', () => {
    expect(z.config().jitless).not.toBe(true);
    jest.requireActual('../src/zodJitless');
    expect(z.config().jitless).toBe(true);
  });

  it('runs before every entry-point import that can build a schema', () => {
    const entry = readFileSync(resolve(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const imports = [...entry.matchAll(/^import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"];?$/gm)].map(
      (match) => match[1],
    );
    // Reanimated must stay first (App.bootstrap.test.tsx); it builds no zod
    // schema, so the only import allowed ahead of the switch is that one.
    expect(imports.slice(0, 2)).toEqual(['react-native-reanimated', './zodJitless']);
    expect(imports.length).toBeGreaterThan(2);
  });
});
