import { expect, test, type Page } from '@playwright/test';

import {
  ENFORCED_FRONTEND_PORT,
  buildEnforcedWebApp,
  removeBuild,
  serveWithNginxHeaders,
  startTlsProxy,
  type EnforcedBuild,
  type StaticServer,
  type TlsProxy,
} from './enforcedWebBuild';
import { backendUrl, logIn, signUp } from './journalHabitsBrowserSupport';

/**
 * The web client under its enforced Content-Security-Policy, with Subresource
 * Integrity (ADR 0009 phase (b), first slice; #3067).
 *
 * Web accounts may not enrol in user-held keys until this protection is live,
 * so it has to be live without breaking the app. Every other browser spec
 * drives the Expo dev server, which never runs the build steps under test. This
 * one exports the production bundle, stamps it with `web-hardening/sri.js`, renders
 * `nginx.conf` with `web-hardening/csp.js`, and serves it with the headers that
 * rendered conf sends (see `enforcedWebBuild.ts`). Then it drives sign-up,
 * a journal page, Settings, log-out and log-in, and the other tabs, and
 * requires that the browser reported no CSP violation at all.
 *
 * "No violation" is only evidence if the recorder can hear one, and only means
 * enforcement if the policy is not report-only. So the spec ends with two
 * planted violations in the same page: an inline script, which must be both
 * reported AND kept from running (a report-only policy would run it), and a
 * fetch to an origin `connect-src` does not list. A second test serves the
 * bundle with one byte changed and requires the browser to refuse it on SRI.
 */

/** Exporting with a cold, private Metro cache takes minutes on a loaded box. */
const BUILD_TIMEOUT_MS = 600_000;
const JOURNEY_TIMEOUT_MS = 180_000;
const JOURNAL_MENU = 'Open Journal menu';
const PROBE_FLAG = '__cspInlineProbeRan';
const UNLISTED_URL = 'https://connect-src-probe.invalid/';

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

let proxy: TlsProxy | undefined;
let build: EnforcedBuild | undefined;
let server: StaticServer | undefined;

test.use({ ignoreHTTPSErrors: true });

test.beforeAll(async () => {
  test.setTimeout(BUILD_TIMEOUT_MS);
  proxy = await startTlsProxy(backendUrl());
  build = await buildEnforcedWebApp(proxy.origin);
  server = await serveWithNginxHeaders(build, ENFORCED_FRONTEND_PORT);
});

test.afterAll(async () => {
  await server?.close();
  await proxy?.close();
  removeBuild(build);
});

function served(): { build: EnforcedBuild; server: StaticServer; proxy: TlsProxy } {
  if (!build || !server || !proxy) throw new Error('the enforced build was not set up');
  return { build, server, proxy };
}

/**
 * Record every CSP violation the page reports, across navigations: the DOM
 * event (exposed bindings and init scripts are injected by the browser, so the
 * policy does not govern them) and Chromium's own console line, in case a
 * violation ever arrives without the event.
 */
async function recordViolations(page: Page): Promise<{ events: Violation[]; console: string[] }> {
  const events: Violation[] = [];
  const consoleLines: string[] = [];
  await page.exposeBinding('__recordCspViolation', (_source, violation: Violation) => {
    events.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as Record<string, (_v: unknown) => void>)
        .__recordCspViolation;
      report?.({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        source: `${event.sourceFile}:${String(event.lineNumber)}`,
      });
    });
  });
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) consoleLines.push(message.text());
  });
  return { events, console: consoleLines };
}

async function writeJournalPage(page: Page, title: string, body: string): Promise<void> {
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill(title);
  await page.getByTestId('journal-body-input').fill(body);
  await page.getByTestId('journal-close-entry').click();
  const response = await created;
  expect(response.ok()).toBe(true);
  // The write crossed origins: from the page to the https API origin the
  // rendered connect-src names, not to the page's own origin.
  expect(new URL(response.url()).origin).toBe(served().proxy.origin);
  const entryId = ((await response.json()) as { id: number }).id;
  await expect(page.getByTestId(`journal-shelf-open-${String(entryId)}`)).toContainText(title);
}

async function visit(page: Page, path: string, anchor: string): Promise<void> {
  await page.goto(`${served().server.url}${path}`);
  await expect(page.getByTestId(anchor).first()).toBeVisible();
}

test('the production build runs under the enforced policy with no violation', async ({ page }) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const { build: built, server: site, proxy: api } = served();
  const violations = await recordViolations(page);

  // What was served is what the record claims: enforced, never report-only,
  // narrowed to this build's API origin, and every script pinned by hash.
  const shell = await page.request.get(`${site.url}/journal`);
  expect(shell.headers()['content-security-policy']).toBe(built.policy);
  expect(shell.headers()['content-security-policy-report-only']).toBeUndefined();
  expect(built.policy).toContain(`connect-src 'self' ${api.origin} `);
  expect(built.policy).toContain("script-src 'self';");
  const scripts = (await shell.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag).toMatch(/\sintegrity="sha384-[A-Za-z0-9+/]+={0,2}"/);

  const email = await signUp(page, 'csp-enforced', site.url);
  await writeJournalPage(page, 'Under the policy', 'Written while the browser enforced it.');

  // Settings, then out and back in through the log-in screen.
  await visit(page, '/settings', 'settings-hub-screen');
  await page.getByTestId('settings-row-timezone').click();
  await expect(page.getByTestId('timezone-settings-screen')).toBeVisible();
  await visit(page, '/api-key-settings', 'api-key-settings-screen');
  await visit(page, '/settings', 'settings-hub-screen');
  await page.getByTestId('settings-row-logout').click();
  await expect(page.getByRole('button', { name: JOURNAL_MENU })).toHaveCount(0);
  await logIn(page, email, site.url);

  // The rest of the app, each tab loaded fresh under the policy and left to
  // finish its reads, so anything it fetches or renders late is still heard.
  for (const tab of ['Habits', 'Practice', 'Course', 'Map', 'Journal']) {
    await page.goto(`${site.url}/${tab.toLowerCase()}`);
    await expect(page.getByRole('button', { name: `Open ${tab} menu` })).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  expect(violations.events).toEqual([]);
  expect(violations.console).toEqual([]);

  // Controls, in the same page. An inline script is refused and reported; a
  // report-only policy would have reported it and let it run.
  await page.evaluate((flag) => {
    const script = document.createElement('script');
    script.textContent = `window.${flag} = true;`;
    document.head.appendChild(script);
  }, PROBE_FLAG);
  await expect.poll(() => violations.events.map((v) => v.directive)).toContain('script-src-elem');
  expect(
    await page.evaluate((flag) => (window as unknown as Record<string, unknown>)[flag], PROBE_FLAG),
  ).toBeUndefined();

  // And a fetch to an origin connect-src does not list never leaves the page.
  const reached = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return true;
    } catch {
      return false;
    }
  }, UNLISTED_URL);
  expect(reached).toBe(false);
  await expect
    .poll(() =>
      violations.events.filter((v) => v.directive === 'connect-src').map((v) => v.blocked),
    )
    .toEqual([UNLISTED_URL]);
});

test('a bundle changed after the build is refused by its integrity hash', async ({
  browser,
  page,
}) => {
  const { server: site } = served();
  // The control, in its own context so neither load can reuse the other's
  // cached bundle: untampered, the page mounts.
  const control = await browser.newContext({ ignoreHTTPSErrors: true });
  const controlPage = await control.newPage();
  await controlPage.goto(`${site.url}/journal`);
  await expect(controlPage.locator('#root')).not.toBeEmpty();
  await control.close();

  const refusals: string[] = [];
  page.on('console', (message) => {
    if (/integrity/i.test(message.text())) refusals.push(message.text());
  });
  site.tamperScripts = true;
  try {
    await page.goto(`${site.url}/journal`);
    await expect.poll(() => refusals.length).toBeGreaterThan(0);
    expect(refusals.join('\n')).toMatch(/SHA-384/);
    // Nothing mounted: the refused bundle never ran.
    await expect(page.locator('#root')).toBeEmpty();
  } finally {
    site.tamperScripts = false;
  }
});
