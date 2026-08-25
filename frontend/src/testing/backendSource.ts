import * as fs from 'fs';
import * as path from 'path';

/**
 * The one supported way for a frontend test to read backend source.
 *
 * A few tests mirror a value the backend owns -- the ten APTITUDE colours and
 * their schedule, the upload cap, which consent sources something actually
 * writes to. A mirror is only honest while something fails when it drifts, so
 * those tests derive their expectations from the Python instead of restating
 * it, and they are the only frontend tests that read outside `frontend/`.
 *
 * That makes them a set CI has to know about: `frontend-ci.yml` is scoped to
 * `frontend/**` on purpose, so a backend-only change never runs them, and one
 * such change reached `main` red. `backend-ci.yml` now runs exactly these
 * tests, and `scripts/frontend/cross-boundary-drift.sh` finds them by looking
 * for an import of this module. Importing it is therefore the declaration:
 * there is no list to keep in step, and a guard written tomorrow is covered
 * the moment it reads anything through here.
 *
 * Reading `backend/` any other way is a hard error -- `jest.setup.crossBoundary.js`
 * watches the filesystem during every suite and fails one that reached across
 * the boundary without this import, because a guard the runner cannot find is
 * a guard that does not run where it matters.
 */

/**
 * The repository root, resolved once here rather than by each caller.
 *
 * Every guard used to count `..` segments up from its own directory, which is
 * both duplication and a footgun: the count differs per nesting depth, and a
 * moved file resolves somewhere silently wrong.
 */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The backend tree. Nothing here hands out a path outside it. */
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

/**
 * An absolute path to a file in the backend tree.
 *
 * @param segments - Path segments below `backend/`, e.g. `'src', 'errors.py'`.
 * @returns The absolute path, whether or not the file exists.
 */
export function backendPath(...segments: string[]): string {
  return path.join(BACKEND_DIR, ...segments);
}

/**
 * The text of a backend file, or a failure naming what could not be read.
 *
 * A missing file throws rather than returning an empty string, so a rename on
 * the backend side surfaces as this guard failing rather than as a regex that
 * quietly matches nothing.
 *
 * @param segments - Path segments below `backend/`.
 * @returns The file's contents, decoded as UTF-8.
 */
export function readBackendSource(...segments: string[]): string {
  const file = backendPath(...segments);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} does not exist; the frontend mirrors a backend file that moved.`);
  }
  return fs.readFileSync(file, 'utf-8');
}

/**
 * Every `.py` file under a backend directory, recursively.
 *
 * Used by sweeps whose honesty depends on covering the whole population rather
 * than a remembered handful of modules.
 *
 * @param segments - Path segments below `backend/` naming the directory to walk.
 * @returns Absolute paths, in directory-entry order.
 */
export function backendPythonFiles(...segments: string[]): string[] {
  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.py') ? [full] : [];
    });

  return walk(backendPath(...segments));
}
