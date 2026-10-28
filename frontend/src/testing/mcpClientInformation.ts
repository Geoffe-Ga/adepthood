import { z } from 'zod';

/**
 * The MCP TypeScript SDK's judgement of a dynamic-registration response (#3543).
 *
 * An agent that signs in through `@modelcontextprotocol/sdk` -- OpenClaw among
 * them -- parses `POST /oauth/register`'s body with the SDK's
 * `OAuthClientInformationFullSchema` before it does anything else, and gives up
 * on the sign-in when that parse fails. The SDK is not a dependency here (no app
 * code speaks to an agent's side of the wire), so this module restates the
 * schema field for field, mirrored from `src/shared/auth.ts` of
 * `@modelcontextprotocol/sdk` 1.32.0 (`SafeUrlSchema`, `OptionalSafeUrlSchema`,
 * `OAuthClientMetadataSchema`, `OAuthClientInformationSchema`).
 *
 * The property that matters is the SDK's: every optional field is a value *or
 * absent*, never `null`. `OptionalSafeUrlSchema` admits a URL, nothing, or the
 * empty string -- a `"logo_uri": null` fails it with "Invalid input", which is
 * exactly how OpenClaw 2026.10.7 refused this server's registrations.
 */

/** URL schemes the SDK refuses even when the address otherwise parses. */
const REFUSED_SCHEMES: ReadonlySet<string> = new Set(['javascript:', 'data:', 'vbscript:']);

/**
 * `SafeUrlSchema`: an absolute URL that is not a script or inline-data scheme.
 *
 * The parseability check is fatal, as the SDK's is, so the scheme check never
 * sees a value `new URL` would throw on.
 */
const SafeUrl = z
  .url()
  .refine((value) => URL.canParse(value), { message: 'URL must be parseable', abort: true })
  .refine((value) => !REFUSED_SCHEMES.has(new URL(value).protocol), {
    message: 'URL cannot use javascript:, data:, or vbscript: scheme',
  });

/** `OptionalSafeUrlSchema`: a safe URL, absent, or `""` (read as absent). Never `null`. */
const OptionalSafeUrl = SafeUrl.optional().or(z.literal('').transform(() => undefined));

/** `OAuthClientMetadataSchema`: RFC 7591 section 2, as the SDK reads it. */
const OAuthClientMetadata = z.object({
  redirect_uris: z.array(SafeUrl),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_name: z.string().optional(),
  client_uri: SafeUrl.optional(),
  logo_uri: OptionalSafeUrl,
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: OptionalSafeUrl,
  policy_uri: z.string().optional(),
  jwks_uri: SafeUrl.optional(),
  // The SDK types this one `z.any()`; any JSON value, absent included, is read.
  jwks: z.unknown().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
  software_statement: z.string().optional(),
});

/** `OAuthClientInformationSchema`: what the server adds on registering the client. */
const OAuthClientInformation = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
});

/** `OAuthClientInformationFullSchema`: the metadata and the information, merged. */
export const OAuthClientInformationFull = OAuthClientMetadata.extend(OAuthClientInformation.shape);
