/**
 * The subset of nginx that `frontend/nginx.conf` uses, read from the conf
 * itself, so the CSP journey serves the exported build with exactly the
 * headers production sends (ADR 0009 phase (b), #3067).
 *
 * The lane has no nginx binary and no Docker daemon, so this decides, for one
 * request path, what the conf's `server` block would answer:
 *
 * - location selection in nginx's order: an exact `= /path` match wins, then
 *   the first matching regex (`~` / `~*`) in file order, then the longest
 *   prefix;
 * - `return <code>;`, and `try_files $uri $uri/ <fallback>`, whose fallback is
 *   an internal redirect that re-runs selection (so a SPA route is answered by
 *   `location = /index.html`, and gets its headers);
 * - a location with no `try_files` serving the file at `root + uri`, or 404;
 * - `add_header` inheritance: a location with any `add_header` of its own
 *   inherits none from the server level, which is the trap the conf's repeated
 *   headers exist to defeat.
 *
 * Pure: the caller says which files exist, so the decision is unit-testable
 * against the real conf (`__tests__/nginxEmulator.test.ts`).
 */

export type Header = readonly [name: string, value: string];

interface Location {
  modifier: '=' | '~' | '~*' | '';
  pattern: string;
  headers: Header[];
  returnCode: number | null;
  tryFiles: string[] | null;
}

export interface NginxPlan {
  serverHeaders: Header[];
  index: string;
  locations: Location[];
}

export type NginxAnswer =
  | { status: number; file: string; headers: Header[] }
  | { status: number; file: null; headers: Header[] };

const NOT_FOUND = 404;
const OK = 200;
/** nginx caps internal redirects at 10; one is all `try_files` here needs. */
const MAX_INTERNAL_REDIRECTS = 10;

const ADD_HEADER = /add_header\s+([\w-]+)\s+"([^"]*)"(?:\s+always)?\s*;/g;
const LOCATION = /location\s+(=|~\*|~)?\s*(\S+)\s*\{([^}]*)\}/g;

function headersIn(text: string): Header[] {
  return [...text.matchAll(ADD_HEADER)].map((match) => [match[1] ?? '', match[2] ?? ''] as const);
}

/** Parse the conf's single `server` block into what request handling needs. */
export function parseNginxConf(conf: string): NginxPlan {
  const code = conf.replace(/#.*$/gm, '');
  const locations: Location[] = [...code.matchAll(LOCATION)].map((match) => {
    const body = match[3] ?? '';
    const returned = /return\s+(\d+)\s*;/.exec(body);
    const tryFiles = /try_files\s+([^;]+);/.exec(body);
    return {
      modifier: (match[1] ?? '') as Location['modifier'],
      pattern: match[2] ?? '',
      headers: headersIn(body),
      returnCode: returned ? Number(returned[1]) : null,
      tryFiles: tryFiles ? (tryFiles[1] ?? '').trim().split(/\s+/) : null,
    };
  });
  const serverLevel = code.replace(LOCATION, '');
  const index = /\bindex\s+(\S+)\s*;/.exec(serverLevel)?.[1] ?? 'index.html';
  return { serverHeaders: headersIn(serverLevel), index, locations };
}

function selectLocation(plan: NginxPlan, uri: string): Location | null {
  const exact = plan.locations.find((loc) => loc.modifier === '=' && loc.pattern === uri);
  if (exact) return exact;
  const regex = plan.locations.find(
    (loc) =>
      (loc.modifier === '~' || loc.modifier === '~*') &&
      new RegExp(loc.pattern, loc.modifier === '~*' ? 'i' : '').test(uri),
  );
  if (regex) return regex;
  const prefixes = plan.locations
    .filter((loc) => loc.modifier === '' && uri.startsWith(loc.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  return prefixes[0] ?? null;
}

/**
 * Where `try_files` settles for `uri`: a file it serves, or a URI it hands to
 * an internal redirect -- its fallback, or a directory's index (the `index`
 * module redirects to `<dir>/index.html`, so that path's location answers).
 */
function tryFiles(
  candidates: readonly string[],
  uri: string,
  index: string,
  exists: (file: string) => boolean,
): { file: string } | { redirect: string } {
  for (const candidate of candidates.slice(0, -1)) {
    const expanded = candidate.replace('$uri', uri);
    if (expanded.endsWith('/')) {
      const directoryIndex = `${expanded.replace(/\/+$/, '')}/${index}`;
      if (exists(directoryIndex)) return { redirect: directoryIndex };
    } else if (exists(expanded)) {
      return { file: expanded };
    }
  }
  return { redirect: candidates[candidates.length - 1] ?? '' };
}

/** One pass of request handling: an answer, or an internal redirect to re-run. */
function handleOnce(
  plan: NginxPlan,
  uri: string,
  exists: (file: string) => boolean,
): NginxAnswer | { redirect: string } {
  const location = selectLocation(plan, uri);
  const headers = location && location.headers.length > 0 ? location.headers : plan.serverHeaders;
  if (location?.returnCode != null) return { status: location.returnCode, file: null, headers };
  if (location?.tryFiles) {
    const tried = tryFiles(location.tryFiles, uri, plan.index, exists);
    return 'redirect' in tried ? tried : { status: OK, file: tried.file, headers };
  }
  const file = uri.endsWith('/') ? `${uri}${plan.index}` : uri;
  return exists(file) ? { status: OK, file, headers } : { status: NOT_FOUND, file: null, headers };
}

/**
 * What the conf answers for a GET of `uri`.
 *
 * @param exists - Whether `root + path` is a file; paths start with `/`.
 */
export function answer(
  plan: NginxPlan,
  uri: string,
  exists: (file: string) => boolean,
): NginxAnswer {
  let current = uri;
  for (let hop = 0; hop < MAX_INTERNAL_REDIRECTS; hop += 1) {
    const handled = handleOnce(plan, current, exists);
    if (!('redirect' in handled)) return handled;
    current = handled.redirect;
  }
  throw new Error(`nginx emulation: internal redirect loop at ${uri}`);
}

/** Every value the plan sends for `name`, wherever it is sent. */
export function headerValues(plan: NginxPlan, name: string): string[] {
  const all = [...plan.serverHeaders, ...plan.locations.flatMap((loc) => loc.headers)];
  return all.filter(([header]) => header.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}
