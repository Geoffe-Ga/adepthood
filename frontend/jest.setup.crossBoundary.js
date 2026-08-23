/* global afterAll, expect */
// Fail any suite that reads backend source without declaring itself.
//
// A few frontend tests derive their expectations from Python so that drift
// fails somewhere. Those tests only earn that job if CI runs them when the
// Python changes, and `frontend-ci.yml` is scoped to `frontend/` -- so
// `backend-ci.yml` runs them instead, discovering them through the one marker
// they all carry: an import of `@/testing/backendSource`.
//
// A marker is a hand-maintained list wearing a disguise unless something
// enforces it. This does: every suite runs with `fs` instrumented, and a suite
// that touched `backend/` without the marker fails at teardown with the fix in
// its message. Omitting the marker is therefore not a quiet gap that surfaces
// months later on a red `main`; it is a red test on the PR that introduces it.
//
// The check is a filesystem observation rather than a source scan, so it is not
// out-thought by a computed path, a helper in another module, or a dynamic
// require. What to make of the observation lives in
// `src/testing/crossBoundaryReport.ts`, where it can be tested directly.

const fs = require('fs');
const path = require('path');

const { undeclaredCrossBoundaryRead } = require('./src/testing/crossBoundaryReport');

const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend') + path.sep;

// `fs` is one object per worker process while this file runs once per suite,
// so the instrumentation is installed at most once and its recorded paths are
// reset for each suite instead.
const INSTRUMENTED = Symbol.for('adepthood.crossBoundary.instrumented');
const READS = Symbol.for('adepthood.crossBoundary.reads');

/** Record a path if it lands inside `backend/`. */
function record(target) {
  // Cheap rejection first: this runs on every file Jest itself reads.
  if (typeof target !== 'string' || !target.includes('backend')) return;
  const resolved = path.resolve(target);
  if (resolved.startsWith(BACKEND_DIR)) {
    fs[READS].add(path.relative(REPO_ROOT, resolved));
  }
}

/** Wrap one `fs` function so its first argument is observed, then pass through. */
function instrument(name) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  fs[name] = function observed(target, ...rest) {
    record(target);
    return original.call(this, target, ...rest);
  };
}

if (fs[INSTRUMENTED] !== true) {
  fs[READS] = new Set();
  // `node:fs` and `fs` are the same module instance, so instrumenting once
  // covers both spellings.
  // Sync API only, deliberately: every cross-boundary guard reads its mirror
  // synchronously at module scope, and a promise-based read would need an await
  // the extractor could not follow anyway. A future guard using `fs/promises`
  // would bypass this instrumentation -- widen the list here if one appears.
  for (const name of ['readFileSync', 'readdirSync', 'existsSync', 'statSync']) {
    instrument(name);
  }
  fs[INSTRUMENTED] = true;
}

// Cleared here rather than in `beforeAll`: a test module's top-level reads run
// after this file and before any hook, and top level is where these guards
// tend to read.
fs[READS].clear();

afterAll(() => {
  const testPath = expect.getState().testPath;
  const failure = undeclaredCrossBoundaryRead(
    path.relative(REPO_ROOT, testPath),
    fs.readFileSync(testPath, 'utf-8'),
    [...fs[READS]].sort(),
  );
  if (failure !== null) {
    throw new Error(failure);
  }
});
