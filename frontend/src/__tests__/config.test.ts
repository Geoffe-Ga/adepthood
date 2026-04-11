import { describe, expect, it } from '@jest/globals';

import { API_BASE_URL, validateApiBaseUrl } from '../config';

const HTTPS_URL = 'https://api.example.com';
const HTTP_URL = 'http://api.example.com';
const DEV_DEFAULT = 'http://localhost:8000';
const ERROR_PREFIX = 'EXPO_PUBLIC_API_BASE_URL must be set to an HTTPS URL in production builds';

describe('config', () => {
  describe('validateApiBaseUrl in development mode', () => {
    it('allows HTTP URLs', () => {
      expect(validateApiBaseUrl(DEV_DEFAULT, true)).toBe(DEV_DEFAULT);
    });

    it('allows HTTPS URLs', () => {
      expect(validateApiBaseUrl(HTTPS_URL, true)).toBe(HTTPS_URL);
    });

    it('allows empty URLs without throwing', () => {
      expect(validateApiBaseUrl('', true)).toBe('');
    });
  });

  describe('validateApiBaseUrl in production mode', () => {
    it('accepts HTTPS URLs', () => {
      expect(validateApiBaseUrl(HTTPS_URL, false)).toBe(HTTPS_URL);
    });

    it('throws for HTTP URLs', () => {
      expect(() => validateApiBaseUrl(HTTP_URL, false)).toThrow(ERROR_PREFIX);
    });

    it('throws for empty URLs', () => {
      expect(() => validateApiBaseUrl('', false)).toThrow(ERROR_PREFIX);
    });

    it('includes the received URL in the error message', () => {
      expect(() => validateApiBaseUrl(HTTP_URL, false)).toThrow(`Received: "${HTTP_URL}"`);
    });

    it('shows "(empty)" for missing URLs in the error message', () => {
      expect(() => validateApiBaseUrl('', false)).toThrow('Received: "(empty)"');
    });
  });

  describe('API_BASE_URL module export', () => {
    it('defaults to http://localhost:8000 in development mode', () => {
      expect(API_BASE_URL).toBe(DEV_DEFAULT);
    });
  });
});
