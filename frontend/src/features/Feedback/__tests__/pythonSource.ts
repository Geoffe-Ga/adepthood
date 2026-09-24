/**
 * Tiny readers for the handful of Python literal shapes the feedback drift
 * guards mirror. They take source TEXT, never a path: the suites that call them
 * read that text through `@/testing/backendSource` themselves, because importing
 * that module is what registers a suite as a cross-boundary guard.
 *
 * Every reader throws when its pattern finds nothing, so a rename on the backend
 * surfaces as a failing guard rather than as an `undefined` that compares equal
 * to nothing in particular.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`could not find ${what} in the backend source`);
  }
  return value;
}

/** `NAME: Final = r"..."` or `NAME: Final = "..."` -> the string body. */
export function pyString(source: string, name: string): string {
  const match = new RegExp(`^${escapeRegExp(name)}: Final = r?"([^"]*)"`, 'm').exec(source);
  return required(match?.[1], name);
}

/** `NAME: Final = 280` -> 280. */
export function pyInt(source: string, name: string): number {
  const match = new RegExp(`^${escapeRegExp(name)}: Final = (\\d+)\\s*$`, 'm').exec(source);
  return Number(required(match?.[1], name));
}

/** The quoted members of `NAME: Final[frozenset[str]] = frozenset({ ... })`. */
export function pyFrozenset(source: string, name: string): string[] {
  const match = new RegExp(
    `^${escapeRegExp(name)}: Final\\[frozenset\\[str\\]\\] = frozenset\\(([^)]*)\\)`,
    'm',
  ).exec(source);
  const body = required(match?.[1], name);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

/** The string values of `class NAME(enum.StrEnum):` members, in declaration order. */
export function pyStrEnum(source: string, className: string): string[] {
  const match = new RegExp(
    `^class ${escapeRegExp(className)}\\(enum\\.StrEnum\\):\\n([\\s\\S]*?)(?=\\n\\S)`,
    'm',
  ).exec(source);
  const body = required(match?.[1], className);
  return [...body.matchAll(/^\s+[A-Z_]+ = "([^"]+)"/gm)].map((m) => m[1] ?? '');
}

/** The field names a pydantic class declares, e.g. `summary: str = Field(...)`. */
export function pyClassFields(source: string, className: string): string[] {
  const start = required(
    new RegExp(`^class ${escapeRegExp(className)}\\(`, 'm').exec(source)?.index,
    className,
  );
  const next = source.indexOf('\nclass ', start + 1);
  const body = source.slice(start, next === -1 ? undefined : next);
  return [...body.matchAll(/^ {4}([a-z_]+): /gm)].map((m) => m[1] ?? '');
}
