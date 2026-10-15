import { describe, expect, it } from '@jest/globals';

import { CREDIT_PACK_LINK, CREDIT_PACK_SAME_EMAIL, creditPackUrl } from '../creditPack';

describe('creditPackUrl — the pack page is offered only when it is safe to open', () => {
  it('keeps a configured https page', () => {
    expect(creditPackUrl('https://creekmasons.gumroad.com/l/credits')).toBe(
      'https://creekmasons.gumroad.com/l/credits',
    );
  });

  it.each([
    ['unset', ''],
    ['plain http', 'http://creekmasons.gumroad.com/l/credits'],
  ])('offers nothing when %s', (_case, configured) => {
    expect(creditPackUrl(configured)).toBeNull();
  });
});

describe('the credit pack offer’s words (#3262)', () => {
  it('names the link plainly', () => {
    expect(CREDIT_PACK_LINK).toBe('Buy BotMason credits');
  });

  it('tells the buyer to use the same email address as their Adepthood account', () => {
    expect(CREDIT_PACK_SAME_EMAIL).toBe(
      'Use the same email address as your Adepthood account when you buy, so the credits reach you.',
    );
  });
});
