/**
 * Every registration response the backend publishes is one an MCP SDK agent accepts (#3543).
 *
 * OpenClaw parses `POST /oauth/register`'s body with the MCP TypeScript SDK's
 * `OAuthClientInformationFullSchema` (mirrored in `@/testing/mcpClientInformation`)
 * and abandoned the sign-in when the server sent `"logo_uri": null`. The
 * backend's own contract test pins the body it sends; this one asks the
 * agent's question of the document it publishes: for every field of the
 * `ClientRegistrationResponse` component, every JSON type the document admits
 * for it is sampled and the SDK must take the result. A nullable field that
 * reappears is admitted by the document, sampled as `null` and refused here --
 * so the document can no longer promise agents a body they would reject.
 */
import { describe, expect, it } from '@jest/globals';

import { readBackendSource } from '@/testing/backendSource';
import { OAuthClientInformationFull } from '@/testing/mcpClientInformation';

interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly items?: JsonSchemaNode;
}

interface ObjectSchema {
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly required: readonly string[];
}

interface OpenApiDocument {
  readonly components: { readonly schemas: Readonly<Record<string, ObjectSchema>> };
}

const COMPONENT = 'ClientRegistrationResponse';
/** A value valid for any string field, including the URL-typed ones the SDK checks. */
const SAMPLE_STRING = 'https://agent.example/callback';
const SAMPLE_NUMBER = 0;
/** The optional metadata the response may carry; the field OpenClaw was refused over. */
const OPTIONAL_METADATA = ['logo_uri'] as const;
/** What the SDK itself requires of a registration response. */
const SDK_REQUIRED = ['client_id', 'redirect_uris'] as const;

/** The published component, failing loudly if the document stopped naming it. */
function publishedComponent(): ObjectSchema {
  const document = JSON.parse(readBackendSource('openapi.json')) as OpenApiDocument;
  const found = document.components.schemas[COMPONENT];
  if (found === undefined) {
    throw new Error(`backend/openapi.json no longer publishes ${COMPONENT}`);
  }
  return found;
}

const component = publishedComponent();

/** One property of the component, failing loudly if it is not declared. */
function property(name: string): JsonSchemaNode {
  const found = component.properties[name];
  if (found === undefined) {
    throw new Error(`${COMPONENT} requires ${name} but declares no schema for it`);
  }
  return found;
}

/** Every JSON type a property schema admits, through `type` lists and unions. */
function admittedTypes(schema: JsonSchemaNode): string[] {
  const own = schema.type === undefined ? [] : [schema.type].flat();
  const members = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  return [...own, ...members.flatMap(admittedTypes)];
}

/** One value of `type`, shaped by the property schema it was admitted by. */
function sample(type: string, schema: JsonSchemaNode): unknown {
  switch (type) {
    case 'string':
      return SAMPLE_STRING;
    case 'integer':
    case 'number':
      return SAMPLE_NUMBER;
    case 'boolean':
      return true;
    case 'array': {
      const items = schema.items ?? { type: 'string' };
      return admittedTypes(items).map((itemType) => sample(itemType, items));
    }
    case 'object':
      return {};
    default:
      return null;
  }
}

/** The smallest body the document allows: its required fields, one sample each. */
function minimalBody(): Record<string, unknown> {
  return Object.fromEntries(
    component.required.map((name) => {
      const schema = property(name);
      const [first] = admittedTypes(schema);
      return [name, first === undefined ? null : sample(first, schema)];
    }),
  );
}

describe('the MCP SDK mirror', () => {
  const body = { client_id: 'cl_x', redirect_uris: [SAMPLE_STRING] };

  it('accepts a registration that omits its optional metadata', () => {
    expect(OAuthClientInformationFull.safeParse(body).success).toBe(true);
  });

  it('refuses the null logo_uri OpenClaw was sent, as the SDK does', () => {
    const parsed = OAuthClientInformationFull.safeParse({ ...body, logo_uri: null });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['logo_uri']);
  });

  it('reads an empty logo_uri as absent, and refuses a script one', () => {
    expect(OAuthClientInformationFull.parse({ ...body, logo_uri: '' })).not.toHaveProperty(
      'logo_uri',
      expect.anything(),
    );
    expect(
      OAuthClientInformationFull.safeParse({ ...body, logo_uri: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });
});

describe(`the published ${COMPONENT}`, () => {
  it('requires everything the SDK requires', () => {
    expect(component.required).toEqual(expect.arrayContaining([...SDK_REQUIRED]));
  });

  it('describes optional metadata the response can leave out', () => {
    for (const name of OPTIONAL_METADATA) {
      expect(component.properties).toHaveProperty(name);
      expect(component.required).not.toContain(name);
    }
  });

  it('admits no body the SDK refuses, field by field and type by type', () => {
    const base = minimalBody();
    expect(OAuthClientInformationFull.safeParse(base).success).toBe(true);

    const refused = Object.entries(component.properties).flatMap(([name, schema]) =>
      admittedTypes(schema)
        .filter(
          (type) =>
            !OAuthClientInformationFull.safeParse({ ...base, [name]: sample(type, schema) })
              .success,
        )
        .map((type) => `${name}: ${type}`),
    );
    expect(refused).toEqual([]);
  });
});
