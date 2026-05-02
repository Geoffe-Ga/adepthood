import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const platformRef: { value: 'ios' | 'android' | 'web' } = { value: 'web' };

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformRef.value;
    },
  },
}));

import { applyWebViewportLock, LOCKED_VIEWPORT_CONTENT } from '../webViewport';

interface FakeMeta {
  attrs: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
}

class FakeDocument {
  metas: FakeMeta[] = [];
  head = {
    appendChild: (el: unknown): unknown => {
      this.metas.push(el as FakeMeta);
      return el;
    },
  };

  createElement(_tag: string): FakeMeta {
    const attrs: Record<string, string> = {};
    return {
      attrs,
      setAttribute(name: string, value: string): void {
        attrs[name] = value;
      },
      getAttribute(name: string): string | null {
        return attrs[name] ?? null;
      },
    };
  }

  querySelector(selector: string): FakeMeta | null {
    const match = /^meta\[name="(.+)"\]$/.exec(selector);
    if (!match) return null;
    return this.metas.find((m) => m.attrs.name === match[1]) ?? null;
  }
}

beforeEach(() => {
  platformRef.value = 'web';
});

describe('applyWebViewportLock', () => {
  it('pins the viewport with maximum-scale=1 on web (suppresses iOS focus zoom)', () => {
    const doc = new FakeDocument();
    applyWebViewportLock(doc);
    expect(doc.metas).toHaveLength(1);
    expect(doc.metas[0]?.getAttribute('name')).toBe('viewport');
    expect(doc.metas[0]?.getAttribute('content')).toBe(LOCKED_VIEWPORT_CONTENT);
    expect(LOCKED_VIEWPORT_CONTENT).toContain('maximum-scale=1');
  });

  it('replaces an existing viewport meta tag rather than appending a duplicate', () => {
    const doc = new FakeDocument();
    const stale = doc.createElement('meta');
    stale.setAttribute('name', 'viewport');
    stale.setAttribute('content', 'width=device-width, initial-scale=1, shrink-to-fit=no');
    doc.head.appendChild(stale);

    applyWebViewportLock(doc);

    expect(doc.metas).toHaveLength(1);
    expect(doc.metas[0]?.getAttribute('content')).toBe(LOCKED_VIEWPORT_CONTENT);
  });

  it('is a no-op on iOS native', () => {
    platformRef.value = 'ios';
    const doc = new FakeDocument();
    applyWebViewportLock(doc);
    expect(doc.metas).toHaveLength(0);
  });

  it('is a no-op on Android native', () => {
    platformRef.value = 'android';
    const doc = new FakeDocument();
    applyWebViewportLock(doc);
    expect(doc.metas).toHaveLength(0);
  });

  it('is a no-op when no document is available (e.g. SSR / node test env)', () => {
    expect(() => {
      applyWebViewportLock();
    }).not.toThrow();
  });
});
