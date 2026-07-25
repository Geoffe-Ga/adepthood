/* eslint-env jest */
/* global describe, it, expect, afterEach, jest */
import { Linking } from 'react-native';

import { openExternalUrl } from '../openExternalUrl';

const PRODUCT_URL = 'https://gumroad.example.com/l/adepthood';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('openExternalUrl', () => {
  it('opens an https URL and resolves true', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);

    await expect(openExternalUrl(PRODUCT_URL)).resolves.toBe(true);

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(PRODUCT_URL);
  });

  it('preserves the query string and fragment of an https URL', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const deepUrl = `${PRODUCT_URL}?wanted=true#buy`;

    await expect(openExternalUrl(deepUrl)).resolves.toBe(true);

    expect(openURL).toHaveBeenCalledWith(deepUrl);
  });

  it('resolves false and warns when the platform refuses to open the URL', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const openURL = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));

    await expect(openExternalUrl(PRODUCT_URL)).resolves.toBe(false);

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not leak the rejection to the caller as an unhandled throw', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Linking, 'openURL').mockImplementation(() => {
      throw new Error('synchronous explosion');
    });

    await expect(openExternalUrl(PRODUCT_URL)).resolves.toBe(false);
  });

  // Only https survives the allowlist: http is downgrade-prone, custom schemes
  // are an app-hijack vector, and javascript: is straight code execution.
  it.each([
    ['http://gumroad.example.com/l/adepthood'],
    ['javascript:alert(1)'],
    ['adepthood://signup'],
    ['file:///etc/passwd'],
    ['ftp://gumroad.example.com/l/adepthood'],
    ['https://'],
    [''],
    ['   '],
  ])('refuses %p without calling Linking.openURL', async (url) => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);

    await expect(openExternalUrl(url)).resolves.toBe(false);

    expect(openURL).not.toHaveBeenCalled();
  });
});
