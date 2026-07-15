/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { MAP_BACKGROUND_URI } from '../images';

describe('MAP_BACKGROUND_URI', () => {
  it('defaults to null (in-app fallback), never an external host', () => {
    // babel-preset-expo inlines EXPO_PUBLIC_* at build time, so the unset var
    // bakes to null -- and this fails if it ever defaulted to any non-null host.
    expect(MAP_BACKGROUND_URI).toBeNull();
  });
});
