import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { API_BASE_URL, CONFIG_ERROR, validateApiBaseUrl } from '../config';
import type * as ConfigModule from '../config';

const HTTPS_URL = 'https://api.example.com';
const HTTP_URL = 'http://api.example.com';
const DEV_DEFAULT = 'http://localhost:8000';
const ERROR_PREFIX = 'EXPO_PUBLIC_API_BASE_URL must be set to an HTTPS URL in production builds';

/**
 * Re-evaluate the config module against the current ``process.env``. The
 * module reads its env vars once at import time, so each env permutation
 * needs a fresh registry entry.
 */
function loadConfig(): typeof ConfigModule {
  return require('../config') as typeof ConfigModule;
}

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

    it('strips a single trailing slash', () => {
      expect(validateApiBaseUrl(`${HTTPS_URL}/`, true)).toBe(HTTPS_URL);
    });

    it('strips multiple trailing slashes', () => {
      expect(validateApiBaseUrl(`${HTTPS_URL}///`, true)).toBe(HTTPS_URL);
    });
  });

  describe('validateApiBaseUrl in production mode', () => {
    it('accepts HTTPS URLs', () => {
      expect(validateApiBaseUrl(HTTPS_URL, false)).toBe(HTTPS_URL);
    });

    it('strips a trailing slash on HTTPS URLs', () => {
      expect(validateApiBaseUrl(`${HTTPS_URL}/`, false)).toBe(HTTPS_URL);
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

    it('does not record a CONFIG_ERROR in development mode', () => {
      expect(CONFIG_ERROR).toBeNull();
    });
  });

  describe('Gumroad URLs', () => {
    const ORIGINAL_ENV = { ...process.env };
    const CUSTOM_PRODUCT_URL = 'https://store.example.com/l/adepthood';
    const CUSTOM_HELP_URL = 'https://help.example.com/license-keys';

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...ORIGINAL_ENV };
      delete process.env.EXPO_PUBLIC_GUMROAD_PRODUCT_URL;
      delete process.env.EXPO_PUBLIC_GUMROAD_HELP_URL;
    });

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
      jest.resetModules();
    });

    it('falls back to a safe https default for the product URL', () => {
      const config = loadConfig();

      expect(config.GUMROAD_PRODUCT_URL).toMatch(/^https:\/\//);
      expect(config.GUMROAD_PRODUCT_URL).toMatch(/gumroad/i);
    });

    it('falls back to a safe https default for the help URL', () => {
      const config = loadConfig();

      expect(config.GUMROAD_HELP_URL).toMatch(/^https:\/\//);
      expect(config.GUMROAD_HELP_URL).toMatch(/gumroad/i);
    });

    it('points the two defaults at different pages', () => {
      const config = loadConfig();

      expect(config.GUMROAD_HELP_URL).not.toBe(config.GUMROAD_PRODUCT_URL);
    });

    it('uses EXPO_PUBLIC_GUMROAD_PRODUCT_URL verbatim when it is set', () => {
      process.env.EXPO_PUBLIC_GUMROAD_PRODUCT_URL = CUSTOM_PRODUCT_URL;

      const config = loadConfig();

      expect(config.GUMROAD_PRODUCT_URL).toBe(CUSTOM_PRODUCT_URL);
    });

    it('uses EXPO_PUBLIC_GUMROAD_HELP_URL verbatim when it is set', () => {
      process.env.EXPO_PUBLIC_GUMROAD_HELP_URL = CUSTOM_HELP_URL;

      const config = loadConfig();

      expect(config.GUMROAD_HELP_URL).toBe(CUSTOM_HELP_URL);
    });

    // These are public marketing links with safe defaults — unlike the API
    // base URL, a missing override must never fail the app closed.
    it('never records a CONFIG_ERROR when both overrides are absent', () => {
      const config = loadConfig();

      expect(config.CONFIG_ERROR).toBeNull();
    });
  });
});
