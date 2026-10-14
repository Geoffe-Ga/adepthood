import { describe, expect, it } from '@jest/globals';

import { httpsLinkOrNull } from '../httpsLink';

describe('httpsLinkOrNull — a configured door out of the app fails closed', () => {
  it('keeps an https URL, trimmed', () => {
    expect(httpsLinkOrNull('  https://example.com/pack \n')).toBe('https://example.com/pack');
  });

  it.each([
    ['nothing configured', ''],
    ['only whitespace', '   '],
    ['a bare scheme', 'https://'],
    ['plain http', 'http://example.com/pack'],
    ['a custom scheme', 'adepthood://pack'],
  ])('resolves %s to null', (_case, configured) => {
    expect(httpsLinkOrNull(configured)).toBeNull();
  });
});
