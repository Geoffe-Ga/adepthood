/**
 * Subresource Integrity for the web export (ADR 0009 phase (b), #3067).
 *
 *   node web-hardening/sri.js stamp <dist>    stamp every page, then verify
 *   node web-hardening/sri.js verify <dist>   verify only
 *
 * Every script and stylesheet a built HTML page serves gets an
 * `integrity="sha384-..."` attribute computed from the file on disk, so the
 * browser refuses a bundle that changed after the build (a tampered CDN edge, a
 * swapped file on the volume). The scripts are same-origin, so no `crossorigin`
 * attribute is needed; a script from another origin is refused outright,
 * because `script-src 'self'` would block it anyway and its hash cannot be
 * computed here.
 *
 * Verification fails (exit 1) on: a script or stylesheet with no integrity; a
 * hash that does not match its file; an inline script (the enforced CSP refuses
 * it, so shipping one is a broken page); a script that is not a file in this
 * build; and a page that serves no script at all, so a build whose shape
 * changed cannot pass vacuously. Usage errors exit 2.
 *
 * CommonJS with Node built-ins only: it runs in the Docker builder stage
 * straight after `expo export`, before anything else is installed.
 */
const { createHash } = require('node:crypto');
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve, sep } = require('node:path');

const ALGORITHM = 'sha384';
const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_USAGE = 2;

const TAG = /<(script|link)\b([^>]*?)(\/?)>/gi;
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const INTEGRITY_ATTRIBUTE = /\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;
/** `<link>` relations whose fetched bytes run or style the page. */
const COVERED_LINK_RELS = new Set(['stylesheet', 'modulepreload']);
const COVERED_PRELOAD_AS = new Set(['script', 'style']);
/** A URL that names its own scheme or host is not a file of this build. */
const FOREIGN_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * @param {string} source - The attribute text of one tag.
 * @returns {Map<string, string>} Lower-cased attribute name to value ('' when bare).
 */
function parseAttributes(source) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * The URL a tag loads that integrity must cover, or null for a tag it does not
 * apply to (an icon, a manifest, an inline script).
 *
 * @param {string} name - `script` or `link`.
 * @param {Map<string, string>} attributes - The tag's attributes.
 * @returns {string | null}
 */
function coveredUrl(name, attributes) {
  if (name === 'script') return attributes.get('src') ?? null;
  const rels = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
  const preloadsCode =
    rels.includes('preload') && COVERED_PRELOAD_AS.has((attributes.get('as') ?? '').toLowerCase());
  const covered = rels.some((rel) => COVERED_LINK_RELS.has(rel)) || preloadsCode;
  return covered ? (attributes.get('href') ?? null) : null;
}

/**
 * The file in `dist` that `url`, referenced from `page`, is served from, or a
 * reason it is not one.
 *
 * @param {string} dist - The export root, which nginx serves as `/`.
 * @param {string} page - The HTML file holding the reference.
 * @param {string} url - The `src` or `href` as written.
 * @returns {{ file: string } | { problem: string }}
 */
function resolveAsset(dist, page, url) {
  if (url === '' || FOREIGN_URL.test(url)) return { problem: 'is not served by this build' };
  const path = decodeURIComponent(url.split(/[?#]/)[0] ?? '');
  const file = path.startsWith('/') ? join(dist, path) : resolve(dirname(page), path);
  if (!resolve(file).startsWith(resolve(dist) + sep)) {
    return { problem: 'is not served by this build' };
  }
  if (!existsSync(file) || !statSync(file).isFile()) return { problem: 'names no such file' };
  return { file };
}

/**
 * @param {string} file - A built asset.
 * @returns {string} The SRI value a browser computes for its bytes.
 */
function digest(file) {
  return `${ALGORITHM}-${createHash(ALGORITHM).update(readFileSync(file)).digest('base64')}`;
}

/**
 * @param {string} dir - A directory to search.
 * @returns {string[]} Every `.html` file below it, sorted.
 */
function htmlPages(dir) {
  /** @type {string[]} */
  const pages = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) pages.push(...htmlPages(path));
    else if (entry.name.endsWith('.html')) pages.push(path);
  }
  return pages.sort();
}

/**
 * Write the current digest onto every covered tag of one page.
 *
 * @param {string} dist - The export root.
 * @param {string} page - The HTML file to rewrite in place.
 */
function stampPage(dist, page) {
  const html = readFileSync(page, 'utf8');
  const stamped = html.replace(TAG, (tag, name, source, selfClose) => {
    const url = coveredUrl(String(name).toLowerCase(), parseAttributes(String(source)));
    if (url === null) return tag;
    const asset = resolveAsset(dist, page, url);
    if (!('file' in asset)) return tag;
    const kept = String(source).replace(INTEGRITY_ATTRIBUTE, '');
    return `<${String(name)}${kept} integrity="${digest(asset.file)}"${String(selfClose)}>`;
  });
  if (stamped !== html) writeFileSync(page, stamped, 'utf8');
}

/**
 * @param {string} html - One page.
 * @returns {number} How many inline scripts (no `src`, non-blank body) it has.
 */
function countInlineScripts(html) {
  return [...html.matchAll(INLINE_SCRIPT)].filter(
    (match) => !parseAttributes(match[1] ?? '').has('src') && (match[2] ?? '').trim() !== '',
  ).length;
}

/**
 * Why one covered tag's integrity is unsound, or null when it is sound.
 *
 * @param {string} dist - The export root.
 * @param {string} page - The HTML file holding the tag.
 * @param {string} url - The `src` or `href` the tag loads.
 * @param {string | undefined} integrity - Its `integrity` attribute, if any.
 * @returns {string | null}
 */
function tagProblem(dist, page, url, integrity) {
  const asset = resolveAsset(dist, page, url);
  if (!('file' in asset)) return `${url} ${asset.problem}`;
  if (integrity === undefined || integrity.trim() === '')
    return `${url} has no integrity attribute`;
  if (integrity.trim() !== digest(asset.file)) return `${url} integrity does not match the file`;
  return null;
}

/**
 * Every reason one page is unsafe to serve under the enforced policy.
 *
 * @param {string} dist - The export root.
 * @param {string} page - The HTML file to check.
 * @returns {string[]} Human-readable problems, empty when the page is sound.
 */
function auditPage(dist, page) {
  const html = readFileSync(page, 'utf8');
  const label = page.slice(resolve(dist).length + 1);
  /** @type {string[]} */
  const problems = [];
  if (countInlineScripts(html) > 0)
    problems.push(`${label}: inline script; script-src 'self' refuses it`);
  let scripts = 0;
  for (const match of html.matchAll(TAG)) {
    const name = (match[1] ?? '').toLowerCase();
    const attributes = parseAttributes(match[2] ?? '');
    const url = coveredUrl(name, attributes);
    if (url === null) continue;
    if (name === 'script') scripts += 1;
    const problem = tagProblem(dist, page, url, attributes.get('integrity'));
    if (problem !== null) problems.push(`${label}: ${problem}`);
  }
  if (scripts === 0) problems.push(`${label}: serves no script; the build changed shape`);
  return problems;
}

/**
 * @param {string} dist - The export root.
 * @returns {string[]} Every problem across every page, or one if there are no pages.
 */
function audit(dist) {
  const pages = htmlPages(dist);
  if (pages.length === 0) return [`${dist}: no HTML page to check`];
  return pages.flatMap((page) => auditPage(dist, page));
}

/**
 * @param {string} dist - The export root.
 */
function stamp(dist) {
  for (const page of htmlPages(dist)) stampPage(dist, page);
}

/**
 * @param {string[]} argv - `[command, dist]`.
 * @returns {number} The process exit code.
 */
function main(argv) {
  const [command, dist] = argv;
  if ((command !== 'stamp' && command !== 'verify') || dist === undefined) {
    console.error('usage: node web-hardening/sri.js <stamp|verify> <dist>');
    return EXIT_USAGE;
  }
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    console.error(`sri: ${dist} is not a directory`);
    return EXIT_USAGE;
  }
  if (command === 'stamp') stamp(dist);
  const problems = audit(dist);
  for (const problem of problems) console.error(`sri: ${problem}`);
  if (problems.length > 0) return EXIT_VIOLATION;
  console.log(`sri: every script and stylesheet in ${dist} carries a matching ${ALGORITHM} hash`);
  return EXIT_OK;
}

module.exports = { audit, digest, main, stamp };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
