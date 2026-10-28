/**
 * The client's copy of the server's rules for where a folder-imported document
 * sat (#3554): an import **namespace** and a `/`-separated **relative path**.
 *
 * The backend refuses any value these reject (`backend/src/domain/upload_source.py`),
 * so mirroring the rules here lets a folder import name an unusable path on the
 * device, in its review, instead of spending a round trip on a 422 for each file.
 * The two length bounds are pinned against the Python by the test beside this
 * module.
 *
 * Both values are identity metadata only. Nothing on either side opens them as
 * a filesystem path.
 */

/** Longest namespace the server accepts, in code points. */
export const MAX_SOURCE_NAMESPACE_LENGTH = 128;

/** Longest relative path the server accepts, in code points. */
export const MAX_SOURCE_RELATIVE_PATH_LENGTH = 1024;

/** The one separator a relative path may use. */
export const SOURCE_PATH_SEPARATOR = '/';

/** Refused rather than translated, so two spellings cannot name one note. */
const BACKSLASH = '\\';

/** Components that mean "here" and "up". */
const RELATIVE_COMPONENTS: readonly string[] = ['.', '..'];

/** A Windows drive prefix roots a path outside the chosen folder. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * What Python's `str.isprintable` rejects, tested one code point at a time:
 * control, format, private-use and unassigned code points, and every separator
 * except the plain ASCII space. Surrogates are checked by range instead of
 * `\p{Cs}`, because the transpiled form of that class matches each half of an
 * ordinary emoji.
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const SPACE_SEPARATOR = /\p{Zs}/u;

/** The one space separator Python counts as printable. */
const ASCII_SPACE = ' ';

/** The UTF-16 surrogate range; a code point here on its own is unpaired. */
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

/** Whether one code point is printable by Python's definition. */
function isPrintableCodePoint(char: string): boolean {
  const code = char.codePointAt(0) ?? SURROGATE_MIN;
  if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) return false;
  if (char === ASCII_SPACE) return true;
  return !NON_PRINTABLE.test(char) && !SPACE_SEPARATOR.test(char);
}

/** Return `value` in NFC, the one form the server computes identity over. */
export function normalizeSourceText(value: string): string {
  return value.normalize('NFC');
}

/**
 * Length in code points, which is what Python's `len` counts. `Array.from`
 * rather than a spread: a transpiled string spread splits surrogate pairs.
 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Whether `value` is non-empty, within `limit`, and printable throughout. */
function isBoundedPrintable(value: string, limit: number): boolean {
  if (value === '' || codePointLength(value) > limit) return false;
  return Array.from(value).every(isPrintableCodePoint);
}

/** Whether `value`, once normalized, is a namespace the server would accept. */
export function isSafeSourceNamespace(value: string): boolean {
  const normalized = normalizeSourceText(value);
  if (!isBoundedPrintable(normalized, MAX_SOURCE_NAMESPACE_LENGTH)) return false;
  return normalized === normalized.trim();
}

/** Whether one `/`-delimited segment is a plain name. */
function isSafeComponent(component: string): boolean {
  return component !== '' && !RELATIVE_COMPONENTS.includes(component);
}

/** Whether `value`, once normalized, is a relative path the server would accept. */
export function isSafeSourceRelativePath(value: string): boolean {
  const normalized = normalizeSourceText(value);
  if (!isBoundedPrintable(normalized, MAX_SOURCE_RELATIVE_PATH_LENGTH)) return false;
  if (normalized.includes(BACKSLASH) || DRIVE_PREFIX.test(normalized)) return false;
  return normalized.split(SOURCE_PATH_SEPARATOR).every(isSafeComponent);
}
