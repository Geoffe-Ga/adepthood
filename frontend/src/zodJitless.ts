import { z } from 'zod';

/**
 * Turn off zod's JIT before any schema exists.
 *
 * zod 4 compiles object parsers with `new Function`, and decides whether it may
 * by calling `new Function("")` as each object schema is constructed. The web
 * build's enforced Content-Security-Policy (`script-src 'self'`, no
 * `'unsafe-eval'`; ADR 0009 phase (b)) refuses that, so the probe throws and
 * zod falls back to its interpreter -- but the refusal is still reported as a
 * `securitypolicyviolation` on every load, noise that would bury a real
 * injection. With `jitless` set, zod skips the probe and never asks.
 *
 * Schemas are built at module load, so this must run before any of them:
 * `src/index.ts` imports it straight after `react-native-reanimated` (which
 * must stay first and builds no schema), ahead of every import that reaches
 * app code, and `__tests__/zodJitless.test.ts` pins that order.
 */
z.config({ jitless: true });
