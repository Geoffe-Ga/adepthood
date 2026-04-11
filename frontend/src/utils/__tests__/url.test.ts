import { describe, it, expect } from '@jest/globals';

import { isValidUrl } from '../url';

describe('isValidUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://example.com/path?q=1#hash')).toBe(true);
  });

  it('accepts http URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('http://localhost:3000')).toBe(true);
  });

  it('rejects javascript: URLs', () => {
    expect(isValidUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects tel: URLs', () => {
    expect(isValidUrl('tel:+1234567890')).toBe(false);
  });

  it('rejects sms: URLs', () => {
    expect(isValidUrl('sms:+1234567890')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isValidUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects intent: URLs', () => {
    expect(isValidUrl('intent://scan/#Intent;scheme=zxing;end')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isValidUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidUrl('')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isValidUrl('not-a-url')).toBe(false);
    expect(isValidUrl('://missing-scheme')).toBe(false);
  });
});
