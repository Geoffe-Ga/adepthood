/**
 * Call a writer's own AI vendor straight from their device (ADR 0009 phase (a), #3067).
 *
 * Under the owner's decision, a writer's own key and the content of a call made
 * with it do not pass through Adepthood: the device sends the request to the
 * vendor that key belongs to. This module is that transport for a page read --
 * one image in, its text out -- for the two vendors the app supports.
 *
 * Both are reachable from a browser. Anthropic answers a cross-origin request
 * only when it carries {@link ANTHROPIC_BROWSER_ACCESS_HEADER}; OpenAI's API
 * allows cross-origin requests as it is. The enforced web CSP already admits
 * both origins in `connect-src` (`frontend/nginx.conf`), which
 * `__tests__/byokDirect.test.ts` pins. Native has no CORS to satisfy.
 *
 * PRIVACY: a {@link DirectVendorError} carries a closed `kind`, the HTTP status
 * and a static message. It never carries the key, the page, the vendor's reply
 * or its error body, and it sets no `cause`, so nothing a caller logs or reports
 * can hold any of them.
 */
import {
  DIRECT_VISION_MODELS,
  TRANSCRIPTION_MAX_TOKENS,
  TRANSCRIPTION_SYSTEM_PROMPT,
} from './transcriptionContract';

import { providerForKey } from '@/features/Settings/byokProviders';

/** Where each vendor's single-turn endpoint lives. */
export const DIRECT_VENDOR_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
} as const;

type Vendor = keyof typeof DIRECT_VENDOR_ENDPOINTS;

/** The Messages API version this request shape is written against. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Anthropic's opt-in for a request sent from a browser with the caller's own key. */
export const ANTHROPIC_BROWSER_ACCESS_HEADER = 'anthropic-dangerous-direct-browser-access';

/**
 * How a direct call failed, in the vocabulary the server used for the same
 * conditions so callers need no second taxonomy. `unrecognised_key` is a key
 * whose prefix names no supported vendor; it never leaves the device.
 */
export type DirectVendorErrorKind =
  | 'credit_exhausted'
  | 'rate_limited'
  | 'provider_error'
  | 'network'
  | 'timeout'
  | 'unrecognised_key';

/** A failed direct call. Static message per kind; see the module's PRIVACY note. */
export class DirectVendorError extends Error {
  kind: DirectVendorErrorKind;
  status: number | null;

  constructor(kind: DirectVendorErrorKind, status: number | null = null) {
    super(`direct vendor call failed: ${kind}`);
    this.name = 'DirectVendorError';
    this.kind = kind;
    this.status = status;
  }
}

/** One page to read: its base64 bytes and their declared media type. */
export interface DirectPage {
  imageBase64: string;
  mediaType: string;
}

interface VendorRequest {
  headers: Record<string, string>;
  body: unknown;
}

const RATE_LIMITED_STATUS = 429;
// OpenAI names a spent balance in a machine-readable code; its genuine rate
// limit is the same status with a different code, and stays retryable.
const OPENAI_BILLING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
]);
// Anthropic publishes no code for it: only a 400's prose says so. Matching prose
// is fragile by nature, as the server's copy of this rule says too.
const ANTHROPIC_CREDIT_EXHAUSTED_STATUS = 400;
const ANTHROPIC_CREDIT_EXHAUSTED_PHRASE = 'credit balance is too low';

function anthropicRequest(key: string, page: DirectPage): VendorRequest {
  return {
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_API_VERSION,
      [ANTHROPIC_BROWSER_ACCESS_HEADER]: 'true',
    },
    body: {
      model: DIRECT_VISION_MODELS.anthropic,
      max_tokens: TRANSCRIPTION_MAX_TOKENS,
      system: TRANSCRIPTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: page.mediaType, data: page.imageBase64 },
            },
          ],
        },
      ],
    },
  };
}

function openaiRequest(key: string, page: DirectPage): VendorRequest {
  return {
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: {
      model: DIRECT_VISION_MODELS.openai,
      max_tokens: TRANSCRIPTION_MAX_TOKENS,
      messages: [
        { role: 'system', content: TRANSCRIPTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${page.mediaType};base64,${page.imageBase64}` },
            },
          ],
        },
      ],
    },
  };
}

const REQUEST_BUILDERS: Record<Vendor, (_key: string, _page: DirectPage) => VendorRequest> = {
  anthropic: anthropicRequest,
  openai: openaiRequest,
};

/** A plain object's property, or undefined -- the vendor's JSON is untrusted. */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function anthropicText(data: unknown): string | null {
  const blocks = field(data, 'content');
  if (!Array.isArray(blocks)) return null;
  const textBlock: unknown = blocks.find((block: unknown) => field(block, 'type') === 'text');
  const text = field(textBlock, 'text');
  return typeof text === 'string' ? text : null;
}

function openaiText(data: unknown): string | null {
  const choices = field(data, 'choices');
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const text = field(field(first, 'message'), 'content');
  return typeof text === 'string' ? text : null;
}

const TEXT_READERS: Record<Vendor, (_data: unknown) => string | null> = {
  anthropic: anthropicText,
  openai: openaiText,
};

function isCreditRefusal(vendor: Vendor, status: number, body: unknown): boolean {
  const error = field(body, 'error');
  if (vendor === 'openai') {
    const code = field(error, 'code');
    return typeof code === 'string' && OPENAI_BILLING_REFUSAL_CODES.has(code);
  }
  const message = field(error, 'message');
  return (
    status === ANTHROPIC_CREDIT_EXHAUSTED_STATUS &&
    typeof message === 'string' &&
    message.toLowerCase().includes(ANTHROPIC_CREDIT_EXHAUSTED_PHRASE)
  );
}

/** The kind a non-2xx vendor answer stands for. */
function refusalKind(vendor: Vendor, status: number, body: unknown): DirectVendorErrorKind {
  if (isCreditRefusal(vendor, status, body)) return 'credit_exhausted';
  if (status === RATE_LIMITED_STATUS) return 'rate_limited';
  return 'provider_error';
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Dispatch with an abort at `timeoutMs`; a transport failure becomes a typed error. */
async function send(url: string, request: VendorRequest, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new DirectVendorError(aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one page with the writer's own key, from this device to that key's
 * vendor, and return the vendor's text exactly as it came back.
 *
 * One attempt, no retry: a failed page is retried by the writer, as it was when
 * the server read it. Throws {@link DirectVendorError} for every failure.
 */
export async function readImageDirect(
  key: string,
  page: DirectPage,
  { timeoutMs }: { timeoutMs: number },
): Promise<string> {
  const vendor = providerForKey(key)?.id;
  if (vendor === undefined) throw new DirectVendorError('unrecognised_key');
  const res = await send(
    DIRECT_VENDOR_ENDPOINTS[vendor],
    REQUEST_BUILDERS[vendor](key, page),
    timeoutMs,
  );
  const data = await readJson(res);
  if (!res.ok) throw new DirectVendorError(refusalKind(vendor, res.status, data), res.status);
  const text = TEXT_READERS[vendor](data);
  if (text === null) throw new DirectVendorError('provider_error', res.status);
  return text;
}
