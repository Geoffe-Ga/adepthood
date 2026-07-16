/**
 * Recency bucketing + absolute date formatting for journal entries, shared by
 * the shelf and its header drawer so both group and label entries identically.
 */
import type { JournalMessage } from '@/api';
import { MS_PER_DAY } from '@/utils/dateUtils';

/** Days within which an entry counts as "This week". */
const WEEK_DAYS = 7;
/** Days within which an entry counts as "This month". */
export const MONTH_DAYS = 30;

/** The recency bands, in display order. */
const RECENCY_ORDER = ['This week', 'This month', 'Earlier'] as const;

/** One recency band and the entries that fall in it. */
export interface ShelfSection {
  title: string;
  data: JournalMessage[];
}

/** Absolute "Month D, YYYY" label for a timestamp; '' for an unparseable one. */
export function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Bucket name for an entry's age relative to ``now`` (epoch ms). */
function bucketFor(timestamp: string, now: number): string {
  const ms = new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return 'Earlier';
  const age = (now - ms) / MS_PER_DAY;
  if (age < WEEK_DAYS) return 'This week';
  if (age < MONTH_DAYS) return 'This month';
  return 'Earlier';
}

/** Group entries into recency sections, dropping any section with no entries. */
export function groupByRecency(items: JournalMessage[], now: number): ShelfSection[] {
  return RECENCY_ORDER.map((title) => ({
    title,
    data: items.filter((item) => bucketFor(item.timestamp, now) === title),
  })).filter((section) => section.data.length > 0);
}
