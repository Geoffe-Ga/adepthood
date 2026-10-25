import { describe, expect, it } from '@jest/globals';

import { AGENTS_STOP_CONFIRM, AGENTS_STOPPED, AGENT_GRANT_PHRASES } from '../agentsCopy';

import { readBackendSource } from '@/testing/backendSource';

/**
 * One permission, one sentence, on both surfaces a person reads it on (#3534).
 *
 * The consent page (#3532) tells a person what an agent may do before they
 * approve it; Settings tells them again beside the Stop button. The two are
 * written in two languages, so this reads the Python mapping back and fails on
 * the day either side changes a phrase, adds a permission, or drops one --
 * rather than the day somebody notices the screens disagree.
 *
 * The same reading pins the "within ten minutes" the Stop copy promises to the
 * access-token lifetime the token endpoint mints with (#3533): stopping an
 * agent ends its next sign-in, and an access token already issued runs out on
 * its own, so the promise is only true while that lifetime is ten minutes.
 */

const CONSENT_COPY = ['src', 'services', 'oauth_consent_copy.py'];
const TOKEN_SERVICE = ['src', 'services', 'oauth_tokens.py'];

/** One ``"scope": "phrase",`` line of the ``GRANT_DESCRIPTIONS`` mapping. */
const MAPPING_ENTRY = /^ {8}"([^"]+)": "([^"]+)",$/gmu;

/** The ``GRANT_DESCRIPTIONS = MappingProxyType({...})`` block, and nothing past it. */
function grantDescriptionsBlock(): string {
  const source = readBackendSource(...CONSENT_COPY);
  const start = source.indexOf('GRANT_DESCRIPTIONS');
  const end = source.indexOf('\n)', start);
  if (start === -1 || end === -1) {
    throw new Error('oauth_consent_copy.py declares no GRANT_DESCRIPTIONS mapping any more.');
  }
  return source.slice(start, end);
}

describe('grant phrases agree with the consent page', () => {
  it('maps exactly the permissions the consent page describes, in its words', () => {
    const backend = [...grantDescriptionsBlock().matchAll(MAPPING_ENTRY)].map(
      ([, scope, phrase]) => [scope, phrase],
    );

    expect(backend.length).toBeGreaterThan(0);
    expect([...AGENT_GRANT_PHRASES.entries()]).toEqual(backend);
  });
});

describe('the Stop copy matches the access-token lifetime', () => {
  it('promises ten minutes because a token lives ten minutes', () => {
    const lifetime = /^ACCESS_TOKEN_TTL: Final = timedelta\(minutes=(\d+)\)$/mu.exec(
      readBackendSource(...TOKEN_SERVICE),
    );

    expect(lifetime?.[1]).toBe('10');
    expect(AGENTS_STOP_CONFIRM).toContain('within ten minutes');
    expect(AGENTS_STOPPED).toContain('within ten minutes');
  });
});
