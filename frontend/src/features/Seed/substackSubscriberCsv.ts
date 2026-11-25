/**
 * Which files of a Substack export list its readers rather than its writing
 * (#3798): the per-post stat CSVs and the subscriber roster.
 *
 * An unpacked export holds, beside each post, a `<post_id>.<slug>.delivers.csv`
 * and a `<post_id>.<slug>.opens.csv` naming everyone the post was sent to and
 * everyone who opened it, and at the top an `email_list*.csv` of every
 * subscriber. They are other people's addresses, so they stay on the device:
 * the single-file picker and a folder import both ask this one predicate, and
 * a file it claims is never read and never sent.
 *
 * The rule is Creek-Vault's, not ours. It is `_is_subscriber_csv` in
 * `creek/ingest/substack.py:196-206`, built from `SUBSCRIBER_CSV_SUFFIXES` and
 * `SUBSCRIBER_LIST_PREFIX` at `creek/ingest/substack.py:84-94`, which is how
 * the same files inside a `.zip` export are already dropped. The test beside
 * this module restates those values and fails when these stop matching them.
 *
 * **The name is all that is inspected.** `posts.csv`, the export's manifest,
 * is not one of these and still goes.
 */

/** The endings of a post's "delivered to" and "opened by" lists. */
export const SUBSCRIBER_CSV_SUFFIXES: readonly string[] = ['.delivers.csv', '.opens.csv'];

/** How the subscriber roster's name begins. */
export const SUBSCRIBER_LIST_PREFIX = 'email_list';

/** The extension the roster carries after its prefix. */
const CSV_EXTENSION = '.csv';

/**
 * Whether `name` (a filename, not a path) is one of a Substack export's stat
 * or subscriber CSVs, judged case-insensitively from the name alone.
 */
export function isSubstackSubscriberCsv(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(SUBSCRIBER_LIST_PREFIX) && lower.endsWith(CSV_EXTENSION)) return true;
  return SUBSCRIBER_CSV_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
