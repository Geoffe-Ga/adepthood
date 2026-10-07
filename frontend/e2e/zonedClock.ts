/**
 * Wall-clock arithmetic in a named zone, for specs that set the page's fake
 * clock to "this time on that day, where the user lives" (#2771).
 *
 * Pure on purpose -- no Playwright import -- so `__tests__/zonedClock.test.ts`
 * can pin it on both sides of a DST change, which a live page cannot be made to
 * sit on.
 */

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME = /^(\d{2}):(\d{2})$/;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1_000;
/** `Intl` spells local midnight as hour 24 under `hourCycle: 'h23'` on some engines. */
const MIDNIGHT_AS_24 = 24;

function parseDayKey(dayKey: string): [number, number, number] {
  const match = DAY_KEY.exec(dayKey);
  if (match === null) throw new Error(`not a YYYY-MM-DD day key: ${dayKey}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseWallTime(wall: string): [number, number] {
  const match = WALL_TIME.exec(wall);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (match === null || hours >= HOURS_PER_DAY || minutes >= MINUTES_PER_HOUR) {
    throw new Error(`not an HH:MM wall time: ${wall}`);
  }
  return [hours, minutes];
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instantMs`, in ms. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = field('hour') % MIDNIGHT_AS_24;
  const wallAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );
  // The formatted parts stop at whole seconds, so compare against the same.
  return wallAsUtc - Math.floor(instantMs / MS_PER_SECOND) * MS_PER_SECOND;
}

/**
 * The instant at which `timeZone`'s wall clock reads `wall` (`HH:MM`) on
 * `dayKey` (`YYYY-MM-DD`).
 *
 * The offset is read at a first guess and then re-read at the answer, so a
 * wall time on the far side of a DST change that day takes that side's offset
 * rather than the morning's.
 */
export function instantAt(dayKey: string, wall: string, timeZone: string): Date {
  const [year, month, day] = parseDayKey(dayKey);
  const [hours, minutes] = parseWallTime(wall);
  const wallAsUtc = Date.UTC(year, month - 1, day, hours, minutes);
  const firstGuess = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  return new Date(wallAsUtc - zoneOffsetMs(firstGuess, timeZone));
}
