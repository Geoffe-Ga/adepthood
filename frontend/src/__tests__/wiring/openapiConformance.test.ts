/**
 * Conformance between ``src/api/schemas.ts`` and the exported OpenAPI document.
 *
 * The two halves of the API contract have always existed separately: the
 * backend commits ``backend/openapi.json`` and gates it in CI, and the frontend
 * validates responses with Zod. Nothing compared them, so they drifted in both
 * directions — and only one of those directions is visible at runtime.
 *
 * - A field Zod declares that the document does not have is a *ghost*. It
 *   parses to ``undefined`` forever. Harmless at runtime, a lie in the type.
 * - A field the document has that Zod does not declare is a *strip*, and it is
 *   the expensive one: ``z.object`` is non-strict, so the value arrives over
 *   the wire and is silently deleted before any caller sees it. Nothing
 *   anywhere reports this.
 *
 * Both are checked here. Every exported schema must reach a verdict: an
 * OpenAPI component, or an explicit ``null`` with a stated reason. A schema
 * this file has never heard of FAILS rather than being skipped — a conformance
 * check that silently passes over what it cannot match reports green while
 * checking nothing, which is worse than having no check at all.
 *
 * Two things it deliberately does not check, so a reader knows the shape of the
 * hole:
 *
 * - **String formats.** ``isoDate`` is a regex and the document says
 *   ``format: date``; comparing those would compare two spellings of the same
 *   intent.
 * - **Array element and nested-object *fields*.** Element *kinds* are compared
 *   (``array<object>`` vs ``array<string>``), but a nested object's own fields
 *   are checked by that object's own entry below, since every item schema on
 *   the wire is itself an exported schema.
 */
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import * as apiSchemas from '../../api/schemas';

import { readBackendSource } from '@/testing/backendSource';

const MIN_JUSTIFICATION_LENGTH = 40;
const MAX_REF_DEPTH = 8;

/** The floor a non-empty enumeration has to clear, so a broken walk cannot pass. */
const MIN_EXPECTED_SCHEMAS = 60;
const MIN_EXPECTED_COMPARED = 40;

interface JsonSchemaNode {
  readonly [key: string]: unknown;
}

interface OpenApiDocument {
  readonly components: { readonly schemas: Record<string, JsonSchemaNode> };
}

/**
 * A hand-written verdict for one exported Zod schema.
 *
 * ``component`` is an override of the name-based auto-match: a string names the
 * component the auto-match cannot find (or finds wrongly), ``null`` states that
 * the wire has no counterpart at all. Supplying the key at all requires a
 * ``reason``.
 *
 * The three field maps are per-field waivers, each keyed by field name and
 * valued by a justification that a human wrote after reading the field. They
 * are DATA, not comments, because an inert comment cannot fail a test: a waiver
 * whose violation has since been fixed is reported as stale, so each list can
 * only shrink.
 */
interface SchemaVerdict {
  readonly component?: string | null;
  readonly reason?: string;
  /** Document field -> why this schema deliberately does not read it. */
  readonly omits?: Readonly<Record<string, string>>;
  /** Zod field -> why it is declared with no counterpart on the wire. */
  readonly ghosts?: Readonly<Record<string, string>>;
  /** Document-required field -> why Zod nonetheless types it optional. */
  readonly lax?: Readonly<Record<string, string>>;
}

/**
 * Every schema whose verdict is not "auto-matches by name and agrees fully".
 *
 * A schema absent from this table must auto-match a component and must show no
 * drift; a schema present here must show exactly the drift it declares.
 */
const SCHEMA_VERDICTS: Readonly<Record<string, SchemaVerdict>> = {
  // --- Renamed or narrowed counterparts -----------------------------------
  acceptSuggestionResultSchema: {
    component: 'AcceptSuggestionResponse',
    reason:
      'The client calls the payload a Result and the server calls it a Response; same object, and the name-based match cannot bridge the two words.',
  },
  apiGoalGroupSchema: {
    component: 'GoalGroupResponse',
    reason:
      'Prefixed "api" in the client to keep it distinct from the local GoalGroup view model, which the name-based match cannot see through.',
  },
  goalCompletionSchema: {
    component: 'GoalCompletionPublic',
    reason:
      'The server suffixes the owner-visible projection "Public" rather than "Response", so no name-based candidate matches.',
  },
  goalSchema: {
    component: 'GoalWithCompletions',
    reason:
      'Goals only ever reach the client nested inside a habit, where the wire ships GoalWithCompletions; the bare Goal component is a request-side shape the client never receives.',
  },
  loginAuthResponseSchema: {
    component: 'AuthResponse',
    reason:
      'The login and refresh paths share the signup component but forbid the user_id=0 anti-enumeration sentinel, so the client narrows one wire shape into two schemas.',
  },
  practiceItemSchema: {
    component: 'PracticeResponse',
    reason:
      'The catalog row is an "Item" to the client and a "Response" to the server; one object, two vocabularies.',
    lax: {
      mode: 'Optional so catalog payloads captured before the practice-mode columns shipped still validate; the live backend always sends it.',
      mode_config:
        'Optional for the same reason as mode, and read only through the mode discriminator, which is itself absent on pre-mode payloads.',
    },
  },

  // --- No counterpart on the wire -----------------------------------------
  careKindSchema: {
    component: null,
    reason:
      'The routing kind is an inline enum inside CareResourceResponse, not a named component; the client hoists it so the four remedies can be exhaustively handled.',
  },
  dataExportArchiveSchema: {
    component: null,
    reason:
      'GET /users/me/export streams its archive instead of returning a response_model, so the document names the media type it sends and declares no schema under it; there is nothing to compare the envelope against.',
  },
  invitationKindSchema: {
    component: null,
    reason:
      'InvitationResponse types kind as a bare string; the client narrows it to the three known kinds so a drifted value fails at the boundary rather than rendering blank.',
  },
  invitationTargetTypeSchema: {
    component: null,
    reason:
      'InvitationResponse types target_type as a bare string, narrowed client-side for the same reason invitationKindSchema is.',
  },
  jwtSchema: {
    component: null,
    reason:
      'A structural predicate over the token string, not a wire object: the document says "string" and this asserts three base64url segments.',
  },
  mettaFocusSchema: {
    component: null,
    reason:
      'ReturnWeekResponse types focus as a bare string; the client pins the five classic Metta foci so an unknown focus cannot render an unlabelled week card.',
  },
  notificationFrequencySchema: {
    component: null,
    reason:
      'An inline enum inside Habit-Output rather than a named component; hoisted here because both the habit schema and the habit editor need the value set.',
  },
  reflectionSourceKindSchema: {
    component: null,
    reason:
      'ReflectionSourceItem types kind as a bare string; the client narrows it to entry/reflection so the sources panel can switch on it exhaustively.',
  },
  relatedPraxisKindSchema: {
    component: null,
    reason:
      'The praxis vocabulary is an inline enum inside RelatedPraxisResponse, not a named component; the client hoists it so the five kinds can be exhaustively handled.',
  },
  relatedPraxisStatusSchema: {
    component: null,
    reason:
      'The lifecycle is an inline enum inside RelatedPraxisResponse for the same reason the kind is, and is hoisted so a released page can never render as an active one.',
  },
  stageManifestationSchema: {
    component: null,
    reason:
      'Nested inside the GET /stages body, which declares no response_model, so the document has no typed counterpart for it either.',
  },
  stageSchema: {
    component: null,
    reason:
      'GET /stages declares no response_model, so the document types the whole body as an empty schema; this schema is the only description of that payload anywhere.',
  },

  // --- Declared laxity on auto-matched pairs ------------------------------
  journalMessageSchema: {
    lax: {
      title:
        'Optional so entries written before the editorial-document columns shipped still validate; the reader falls back to a derived title.',
      status:
        'Optional for the same reason as title; a message with no status is treated as finished, which is what pre-column entries were.',
      updated_at:
        'Optional for the same reason as title; the shelf falls back to the creation timestamp when it is absent.',
      classification:
        'Optional so entries predating the privacy-tier column still validate; an unclassified entry is treated as the most private tier.',
    },
  },
  practiceSessionResponseSchema: {
    lax: {
      mode: 'Optional so sessions logged before the practice-mode column shipped still validate; a session with no mode renders as a plain timed sit.',
    },
  },
};

// ---------------------------------------------------------------------------
// Document + Zod plumbing
// ---------------------------------------------------------------------------

const document = JSON.parse(readBackendSource('openapi.json')) as OpenApiDocument;
const components = document.components.schemas;

/** Every exported ``*Schema`` value that is an actual Zod schema. */
function exportedSchemas(): [string, z.ZodType][] {
  return Object.entries(apiSchemas as Record<string, unknown>)
    .filter(
      (entry): entry is [string, z.ZodType] =>
        entry[0].endsWith('Schema') && entry[1] instanceof z.ZodType,
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Name-based auto-match. The server suffixes response models inconsistently
 * (``Response``, ``Out``, and pydantic's ``-Output`` split for models that
 * differ between request and response), so all four spellings are tried.
 */
function autoMatch(schemaName: string): string | undefined {
  const base = schemaName.replace(/Schema$/, '');
  const pascal = base.charAt(0).toUpperCase() + base.slice(1);
  return [pascal, `${pascal}Response`, `${pascal}Out`, `${pascal}-Output`].find(
    (candidate) => candidate in components,
  );
}

type Resolver = (ref: string) => JsonSchemaNode | undefined;

const componentResolver: Resolver = (ref) => components[ref.replace('#/components/schemas/', '')];

/** Zod emits ``#/$defs/x`` for a sub-schema it reuses inside one document. */
function zodResolver(root: JsonSchemaNode): Resolver {
  const defs = (root.$defs ?? {}) as Record<string, JsonSchemaNode>;
  return (ref) => defs[ref.replace('#/$defs/', '')];
}

function deref(node: JsonSchemaNode, resolve: Resolver): JsonSchemaNode {
  let current = node;
  for (let depth = 0; depth < MAX_REF_DEPTH; depth += 1) {
    const ref = current.$ref;
    if (typeof ref !== 'string') {
      return current;
    }
    current = resolve(ref) ?? {};
  }
  return current;
}

function branches(node: JsonSchemaNode): JsonSchemaNode[] | undefined {
  const union = node.anyOf ?? node.oneOf ?? node.allOf;
  return Array.isArray(union) ? (union as JsonSchemaNode[]) : undefined;
}

function literalType(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function leafTypes(node: JsonSchemaNode): string[] {
  if (typeof node.type === 'string') {
    return [node.type];
  }
  if (Array.isArray(node.enum)) {
    return (node.enum as unknown[]).map(literalType);
  }
  if ('const' in node) {
    return [literalType(node.const)];
  }
  // An empty schema admits anything — pydantic emits it for an untyped body,
  // Zod for z.unknown(). Treated as a wildcard rather than a mismatch.
  return ['*'];
}

/**
 * The set of primitive kinds a node admits, rendered as a stable string.
 *
 * Nullability needs no special case: both sides spell it ``anyOf: [{...},
 * {type: 'null'}]``, so ``null`` simply joins the set.
 */
function typeSet(node: JsonSchemaNode | undefined, resolve: Resolver, depth = 0): string {
  if (node === undefined) {
    return 'absent';
  }
  const resolved = deref(node, resolve);
  const union = branches(resolved);
  if (union !== undefined && depth < MAX_REF_DEPTH) {
    const kinds = union.flatMap((branch) => typeSet(branch, resolve, depth + 1).split('|'));
    return [...new Set(kinds)].sort().join('|');
  }
  if (resolved.type === 'array' && depth < MAX_REF_DEPTH) {
    const items = resolved.items as JsonSchemaNode | undefined;
    return `array<${typeSet(items, resolve, depth + 1)}>`;
  }
  return [...new Set(leafTypes(resolved))].sort().join('|');
}

function enumMembers(node: JsonSchemaNode): string | undefined {
  return Array.isArray(node.enum)
    ? JSON.stringify([...(node.enum as unknown[])].sort())
    : undefined;
}

// ---------------------------------------------------------------------------
// The comparison itself
// ---------------------------------------------------------------------------

interface Violation {
  readonly schema: string;
  readonly kind: 'ghosts' | 'omits' | 'lax';
  readonly field: string;
  readonly detail: string;
}

/** A drift with no per-field waiver: a type or enum disagreement. */
type HardFinding = string;

interface Comparison {
  readonly violations: Violation[];
  readonly hard: HardFinding[];
}

function properties(node: JsonSchemaNode): Record<string, JsonSchemaNode> {
  return (node.properties ?? {}) as Record<string, JsonSchemaNode>;
}

function requiredNames(node: JsonSchemaNode): Set<string> {
  return new Set((node.required ?? []) as string[]);
}

/**
 * Compare presence and required-ness.
 *
 * Only ONE of the two required-ness directions is a finding. FastAPI never
 * serialises a response with ``exclude_unset``, so every declared property of a
 * response model reaches the wire; the document's ``required`` list describes
 * what pydantic needs at construction, not what arrives. A Zod schema that
 * requires a defaulted field is therefore *stricter than the wire*, which fails
 * loudly rather than silently and is the safe direction. A Zod schema that
 * types a document-required field as optional is the reverse: it hands callers
 * ``T | undefined`` for something that always arrives.
 */
function compareFields(name: string, zod: JsonSchemaNode, component: JsonSchemaNode): Violation[] {
  const zodProps = properties(zod);
  const docProps = properties(component);
  const zodRequired = requiredNames(zod);
  const docRequired = requiredNames(component);
  const violations: Violation[] = [];
  for (const field of Object.keys(zodProps)) {
    if (!(field in docProps)) {
      violations.push({ schema: name, kind: 'ghosts', field, detail: 'not on the wire' });
    } else if (docRequired.has(field) && !zodRequired.has(field)) {
      violations.push({ schema: name, kind: 'lax', field, detail: 'wire-required, Zod optional' });
    }
  }
  for (const field of Object.keys(docProps)) {
    if (!(field in zodProps)) {
      violations.push({ schema: name, kind: 'omits', field, detail: 'silently stripped' });
    }
  }
  return violations;
}

function compareTypes(name: string, zod: JsonSchemaNode, component: JsonSchemaNode): HardFinding[] {
  const zodProps = properties(zod);
  const docProps = properties(component);
  const resolveZod = zodResolver(zod);
  const findings: HardFinding[] = [];
  for (const [field, node] of Object.entries(zodProps)) {
    const counterpart = docProps[field];
    if (counterpart === undefined) {
      continue;
    }
    const mine = typeSet(node, resolveZod);
    const theirs = typeSet(counterpart, componentResolver);
    if (mine !== theirs) {
      findings.push(`${name}.${field}: Zod ${mine}, document ${theirs}`);
    }
  }
  return findings;
}

/** Non-object pairs: enums, and anything else the wire types as a scalar. */
function compareScalars(
  name: string,
  zod: JsonSchemaNode,
  component: JsonSchemaNode,
): HardFinding[] {
  const findings: HardFinding[] = [];
  const mine = typeSet(zod, zodResolver(zod));
  const theirs = typeSet(component, componentResolver);
  if (mine !== theirs) {
    findings.push(`${name}: Zod ${mine}, document ${theirs}`);
  }
  const myMembers = enumMembers(zod);
  const theirMembers = enumMembers(component);
  if (myMembers !== undefined && theirMembers !== undefined && myMembers !== theirMembers) {
    findings.push(`${name}: enum members differ — Zod ${myMembers}, document ${theirMembers}`);
  }
  return findings;
}

function compare(name: string, schema: z.ZodType, component: JsonSchemaNode): Comparison {
  const zod = z.toJSONSchema(schema, {
    io: 'output',
    unrepresentable: 'any',
  }) as JsonSchemaNode;
  if (zod.type !== 'object' || component.type !== 'object') {
    return { violations: [], hard: compareScalars(name, zod, component) };
  }
  return {
    violations: compareFields(name, zod, component),
    hard: compareTypes(name, zod, component),
  };
}

// ---------------------------------------------------------------------------
// Resolution: every schema reaches a verdict, or the test fails
// ---------------------------------------------------------------------------

interface Resolution {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly component: string | null;
}

/** A Resolution, or the schema's name when nothing decided its verdict. */
function resolveOne(name: string, schema: z.ZodType): Resolution | string {
  const verdict = SCHEMA_VERDICTS[name];
  if (verdict !== undefined && 'component' in verdict) {
    return { name, schema, component: verdict.component ?? null };
  }
  const matched = autoMatch(name);
  return matched === undefined ? name : { name, schema, component: matched };
}

interface Resolved {
  readonly pairs: Resolution[];
  readonly undecided: string[];
}

function resolveAll(): Resolved {
  const pairs: Resolution[] = [];
  const undecided: string[] = [];
  for (const [name, schema] of exportedSchemas()) {
    const outcome = resolveOne(name, schema);
    if (typeof outcome === 'string') {
      undecided.push(outcome);
    } else {
      pairs.push(outcome);
    }
  }
  return { pairs, undecided };
}

interface Findings {
  readonly violations: Violation[];
  readonly hard: HardFinding[];
  readonly compared: number;
}

function runComparisons(): Findings {
  const violations: Violation[] = [];
  const hard: HardFinding[] = [];
  let compared = 0;
  for (const pair of resolveAll().pairs) {
    if (pair.component === null) {
      continue;
    }
    const component = components[pair.component];
    if (component === undefined) {
      hard.push(`${pair.name}: declared component '${pair.component}' is not in the document`);
      continue;
    }
    compared += 1;
    const result = compare(pair.name, pair.schema, component);
    violations.push(...result.violations);
    hard.push(...result.hard);
  }
  return { violations, hard, compared };
}

function waiverFor(violation: Violation): string | undefined {
  return SCHEMA_VERDICTS[violation.schema]?.[violation.kind]?.[violation.field];
}

function describeViolation(violation: Violation): string {
  return `${violation.schema}.${violation.field} (${violation.kind}): ${violation.detail}`;
}

// ---------------------------------------------------------------------------
// Self-lint: the waiver tables are a ratchet, not a dumping ground
// ---------------------------------------------------------------------------

const WAIVER_KINDS = ['omits', 'ghosts', 'lax'] as const;

function justificationProblems(label: string, text: string | undefined): string[] {
  if (text === undefined || text.trim().length < MIN_JUSTIFICATION_LENGTH) {
    return [`${label} needs a justification of at least ${MIN_JUSTIFICATION_LENGTH} characters`];
  }
  return [];
}

function mappingProblems(name: string, verdict: SchemaVerdict): string[] {
  if (!('component' in verdict)) {
    return [];
  }
  const problems = justificationProblems(`${name} mapping`, verdict.reason);
  const matched = autoMatch(name);
  if (verdict.component === null && matched !== undefined) {
    problems.push(
      `${name} is mapped to null but now auto-matches '${matched}' — remove the override`,
    );
  }
  if (verdict.component !== null && verdict.component === matched) {
    problems.push(`${name} override names the component auto-match already finds — remove it`);
  }
  return problems;
}

function waiverProblems(name: string, verdict: SchemaVerdict, live: Set<string>): string[] {
  const problems: string[] = [];
  for (const kind of WAIVER_KINDS) {
    for (const [field, reason] of Object.entries(verdict[kind] ?? {})) {
      problems.push(...justificationProblems(`${name}.${field} (${kind})`, reason));
      if (!live.has(`${name}|${kind}|${field}`)) {
        problems.push(`stale ${kind} waiver ${name}.${field} — the drift is gone, remove it`);
      }
    }
  }
  return problems;
}

function selfLintProblems(): string[] {
  const exported = new Set(exportedSchemas().map(([name]) => name));
  const live = new Set(runComparisons().violations.map((v) => `${v.schema}|${v.kind}|${v.field}`));
  const problems: string[] = [];
  for (const [name, verdict] of Object.entries(SCHEMA_VERDICTS)) {
    if (!exported.has(name)) {
      problems.push(`${name} is no longer an exported schema — remove its entry`);
      continue;
    }
    problems.push(...mappingProblems(name, verdict), ...waiverProblems(name, verdict, live));
  }
  return problems;
}

describe('wiring: Zod schemas conform to the exported OpenAPI document', () => {
  it('reaches a verdict on every exported schema', () => {
    const { pairs, undecided } = resolveAll();
    // Non-emptiness first: a walk that found nothing would report no undecided
    // schemas forever, and the guard would pass by doing nothing.
    expect(pairs.length + undecided.length).toBeGreaterThanOrEqual(MIN_EXPECTED_SCHEMAS);
    expect(undecided).toEqual([]);
  });

  it('compares every pair it claims to compare', () => {
    expect(runComparisons().compared).toBeGreaterThanOrEqual(MIN_EXPECTED_COMPARED);
  });

  it('has no field drift that is not declared and justified', () => {
    const undeclared = runComparisons()
      .violations.filter((violation) => waiverFor(violation) === undefined)
      .map(describeViolation);
    expect(undeclared).toEqual([]);
  });

  it('has no type or enum disagreement on any compared pair', () => {
    expect(runComparisons().hard).toEqual([]);
  });

  it('keeps every mapping and waiver justified and current', () => {
    expect(selfLintProblems()).toEqual([]);
  });
});
