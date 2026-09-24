/**
 * The diagnostic envelope a beta report carries, built from finite maps only.
 *
 * The server accepts exactly seven keys (`ALLOWED_CONTEXT_KEYS` in
 * `backend/src/schemas/feedback.py`) and every value is a token, a closed enum
 * or a bucket -- nothing a person wrote. This module keeps it that way by
 * construction: `buildFeedbackContext` takes no route params and no free-text
 * argument, and assembles its result key by key rather than spreading anything.
 *
 * `correlation_id` is deliberately OMITTED (#2898, decision D1). The privacy
 * policy's Beta feedback section says the app "may send" one, and today nothing
 * in the client carries a session id -- `src/api/index.ts` only reads the
 * server's `X-Request-ID` off responses and Sentry is not tagged with one -- so a
 * freshly minted UUID would join no telemetry and would only make every report
 * in a session linkable to the others.
 */
import { LOCALE_PATTERN } from './feedbackBounds';
import type { FeedbackControlToken } from './feedbackControlTokens';

import type { FeedbackContext, FeedbackScreen } from '@/api';
import { breakpoints } from '@/design/tokens';

type FeedbackPlatform = FeedbackContext['platform'];
type FeedbackViewportClass = FeedbackContext['viewport_class'];

/** Where the report was filed from, when the route is not one we name. */
export const UNKNOWN_SCREEN_TOKEN: FeedbackScreen = 'app.unknown';

/**
 * Route name -> canonical screen token. Keyed by the navigator's route NAME,
 * which is a developer-chosen identifier; params are never consulted.
 *
 * Every value is a member of the server's closed `FeedbackScreen` vocabulary
 * (typed here, set-compared by `feedbackBoundsDrift.test.ts`): the server
 * refuses any other screen, so a new origin is added on both sides together.
 */
export const SCREEN_TOKEN_BY_ROUTE: Readonly<Record<string, FeedbackScreen>> = {
  Journal: 'journal.shelf',
  Habits: 'habits.grid',
  Practice: 'practice.player',
  Course: 'course.reader',
  Map: 'map.stages',
  Settings: 'settings.hub',
};

/** The tab the shell opens on, for a Tabs route whose child state is not committed yet. */
const TABS_ROUTE = 'Tabs';
const TABS_INITIAL_ROUTE = 'Journal';
const COMPOSER_ROUTE = 'Feedback';

/** Widths at or above this are `regular` (the design `md` breakpoint). */
export const VIEWPORT_REGULAR_MIN_WIDTH = breakpoints.md;
/** Widths at or above this are `expanded` (the design `lg` breakpoint). */
export const VIEWPORT_EXPANDED_MIN_WIDTH = breakpoints.lg;

/**
 * Where a platform outside the server's closed set is reported. The app ships
 * for iOS, Android and the web only; any other React Native target would be an
 * out-of-tree desktop build, which renders through the same DOM-like layout
 * rules as the web bundle, so `web` is the least wrong bucket.
 */
export const PLATFORM_FALLBACK: FeedbackPlatform = 'web';

const KNOWN_PLATFORMS: ReadonlyMap<string, FeedbackPlatform> = new Map<string, FeedbackPlatform>([
  ['android', 'android'],
  ['ios', 'ios'],
  ['web', 'web'],
]);

/** Map `Platform.OS` onto the server's closed set. */
export function platformFor(os: string): FeedbackPlatform {
  return KNOWN_PLATFORMS.get(os) ?? PLATFORM_FALLBACK;
}

/** Bucket a window width. An exact size would be a fingerprint; a class is not. */
export function viewportClassFor(width: number): FeedbackViewportClass {
  if (width < VIEWPORT_REGULAR_MIN_WIDTH) return 'compact';
  if (width < VIEWPORT_EXPANDED_MIN_WIDTH) return 'regular';
  return 'expanded';
}

const TWO_LETTER_REGION = /^[A-Za-z]{2}$/;

/**
 * Narrow a runtime locale to language plus an optional two-letter region:
 * `zh-Hant-TW` -> `zh-TW`, `en_US` -> `en-US`, `es-419` -> `es`. Anything that
 * still does not fit the server's pattern is dropped rather than sent.
 */
export function narrowLocale(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const [language = '', ...rest] = raw.replace(/_/g, '-').split('-');
  const region = rest.find((part) => TWO_LETTER_REGION.test(part));
  const narrowed =
    region === undefined
      ? language.toLowerCase()
      : `${language.toLowerCase()}-${region.toUpperCase()}`;
  return LOCALE_PATTERN.test(narrowed) ? narrowed : undefined;
}

/** The runtime's locale, or `undefined` on a runtime without `Intl`. */
export function resolveDeviceLocale(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** The slice of React Navigation state this module reads: names and indices. */
export interface NavStateLike {
  index?: number;
  routes: ReadonlyArray<{ name: string; state?: NavStateLike }>;
}

function focusedName(state: NavStateLike | undefined): string | undefined {
  if (state === undefined) return undefined;
  return state.routes[state.index ?? 0]?.name;
}

/**
 * The route the person was on when they opened the composer.
 *
 * Reads the root stack: the route directly below `Feedback` (or the top route,
 * if the composer is not on the stack), descending one level into the tab
 * shell to name the focused tab. Only `.name` is ever read -- the `params` that
 * sit beside it (an entry id, a prefilled quote) are never touched.
 */
export function resolveOriginRouteName(state: NavStateLike | undefined): string | undefined {
  if (state === undefined) return undefined;
  const top = state.index ?? state.routes.length - 1;
  const originIndex = state.routes[top]?.name === COMPOSER_ROUTE ? top - 1 : top;
  const origin = state.routes[originIndex];
  if (origin === undefined) return undefined;
  if (origin.name !== TABS_ROUTE) return origin.name;
  return focusedName(origin.state) ?? TABS_INITIAL_ROUTE;
}

/** Everything the envelope is built from. Deliberately no params, no text. */
export interface FeedbackContextInput {
  routeName: string | undefined;
  control: FeedbackControlToken | undefined;
  width: number;
  os: string;
  locale: string | undefined;
  appBuild: string;
}

/** A Map, so an inherited Object key such as `toString` can never name a screen. */
const SCREEN_TOKENS: ReadonlyMap<string, FeedbackScreen> = new Map(
  Object.entries(SCREEN_TOKEN_BY_ROUTE),
);

function screenTokenFor(routeName: string | undefined): FeedbackScreen {
  return (
    (routeName === undefined ? undefined : SCREEN_TOKENS.get(routeName)) ?? UNKNOWN_SCREEN_TOKEN
  );
}

/** Build the seven-key envelope, key by key. */
export function buildFeedbackContext(input: FeedbackContextInput): FeedbackContext {
  const context: FeedbackContext = {
    screen: screenTokenFor(input.routeName),
    platform: platformFor(input.os),
    app_build: input.appBuild,
    viewport_class: viewportClassFor(input.width),
  };
  if (input.control !== undefined) context.control = input.control;
  const locale = narrowLocale(input.locale);
  if (locale !== undefined) context.locale = locale;
  return context;
}
