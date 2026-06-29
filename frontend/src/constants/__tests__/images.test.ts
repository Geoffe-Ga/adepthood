/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { MAP_BACKGROUND_URI } from '../images';

describe('MAP_BACKGROUND_URI', () => {
  it('never defaults to an external placeholder host (#766)', () => {
    // With EXPO_PUBLIC_MAP_BACKGROUND_URI unset (the default build/test env) the
    // value is null and the Map screen renders a branded in-app fallback — it
    // must never ship the third-party "600 × 800" placehold.co image.
    expect(MAP_BACKGROUND_URI).toBeNull();
  });

  it('is not a placehold.co URL when configured', () => {
    if (MAP_BACKGROUND_URI) {
      expect(MAP_BACKGROUND_URI).not.toContain('placehold');
    }
  });
});
