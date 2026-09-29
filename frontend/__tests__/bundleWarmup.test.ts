import { describe, expect, it } from '@jest/globals';

import { scriptUrls, warmBundles, type FetchLike } from '../e2e/bundleWarmup';

/**
 * The browser lane's bundle warm-up (#2860 CI fix). Expo's dev server answers
 * the HTML shell at once but compiles the JS bundle only when it is first
 * requested, so whichever spec navigates first used to pay the whole cold
 * compile inside its own action timeout. Global setup now fetches every
 * bundle the shell references before any spec runs. These tests pin the two
 * halves a live Expo cannot be made to misbehave on demand: reading the
 * shell's script URLs, and giving up loudly on a bundle that will never come.
 */

const FRONTEND = 'http://127.0.0.1:3000';
/** The shell Expo SDK web serves today, script tag verbatim (checked by hand). */
const EXPO_SHELL =
  '<!DOCTYPE html><html><head><title>Adepthood</title></head><body>' +
  '<div id="root"></div>' +
  '<script src="/src/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true' +
  '&transform.engine=hermes" defer></script></body></html>';

/** A fetch that answers from a script of responses, recording every URL asked for. */
function scripted(
  responses: Array<{ status: number; body: string } | Error>,
): FetchLike & { asked: string[] } {
  const asked: string[] = [];
  const next = async (url: string) => {
    asked.push(url);
    const response = responses.shift();
    if (response === undefined) throw new Error('the scripted fetch ran out of responses');
    if (response instanceof Error) throw response;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    };
  };
  return Object.assign(next, { asked });
}

const soon = (): number => Date.now() + 1_000;

describe('scriptUrls', () => {
  it("resolves Expo's relative bundle src against the frontend, query string intact", () => {
    expect(scriptUrls(EXPO_SHELL, FRONTEND)).toEqual([
      'http://127.0.0.1:3000/src/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes',
    ]);
  });

  it('keeps an absolute src, decodes &amp; and reads single quotes, in document order', () => {
    const html =
      "<script src='https://cdn.example.com/a.js?x=1&amp;y=2'></script>" +
      '<script type="module" src="chunk.js"></script>';
    expect(scriptUrls(html, `${FRONTEND}/journal/`)).toEqual([
      'https://cdn.example.com/a.js?x=1&y=2',
      'http://127.0.0.1:3000/journal/chunk.js',
    ]);
  });

  it('ignores inline scripts, which have nothing to fetch', () => {
    const html = '<script>window.__ENV = {}</script><script src="/app.bundle"></script>';
    expect(scriptUrls(html, FRONTEND)).toEqual(['http://127.0.0.1:3000/app.bundle']);
  });

  it('refuses a shell with no script src rather than warming nothing and passing', () => {
    const html = '<div id="root"></div><script>inline()</script>';
    expect(() => scriptUrls(html, FRONTEND)).toThrow(/no <script src>/);
  });
});

describe('warmBundles', () => {
  const bundle = `${FRONTEND}/src/index.ts.bundle?platform=web`;

  it('asks for every bundle until it answers 200 with a body', async () => {
    const fetchImpl = scripted([
      new Error('ECONNRESET'),
      { status: 503, body: '' },
      { status: 200, body: '' },
      { status: 200, body: 'var __BUNDLE__;' },
      { status: 200, body: 'second' },
    ]);
    await warmBundles([bundle, `${FRONTEND}/b.js`], { deadline: soon(), fetchImpl, retryMs: 0 });
    expect(fetchImpl.asked).toEqual([bundle, bundle, bundle, bundle, `${FRONTEND}/b.js`]);
  });

  it('throws at once, naming the URL, when a bundle 404s -- it will never compile', async () => {
    const fetchImpl = scripted([{ status: 404, body: 'Not found' }]);
    await expect(
      warmBundles([bundle], { deadline: Date.now() + 60_000, fetchImpl, retryMs: 0 }),
    ).rejects.toThrow(`${bundle} answered 404`);
    expect(fetchImpl.asked).toHaveLength(1);
  });

  it('throws when the deadline passes before the bundle answers, with the last outcome', async () => {
    const fetchImpl = scripted(
      Array.from({ length: 50 }, () => ({ status: 500, body: 'SyntaxError in App.tsx' })),
    );
    await expect(
      warmBundles([bundle], { deadline: Date.now() + 20, fetchImpl, retryMs: 5 }),
    ).rejects.toThrow(/did not answer 200 with a body before the deadline \(last: 500/);
  });

  it('refuses an empty list rather than reporting the bundle warm', async () => {
    await expect(
      warmBundles([], { deadline: soon(), fetchImpl: scripted([]), retryMs: 0 }),
    ).rejects.toThrow(/nothing to warm/);
  });
});
