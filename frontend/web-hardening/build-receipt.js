/**
 * Stamp the web distribution with the platform commit that built it (#3164).
 * The operator observes this file independently of the backend receipt.
 * No free-form release label or runtime setting is a source of provenance.
 *
 *   node web-hardening/build-receipt.js <existing-dist-directory>
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dist = process.argv[2];
if (!dist || process.argv.length !== 3) {
  console.error('Usage: node web-hardening/build-receipt.js <dist-directory>');
  process.exit(2);
}

const platformCommit = process.env.RAILWAY_GIT_COMMIT_SHA ?? '';
// JS's $ also matches before a final newline. Check the length so only the
// exact full lowercase SHA is accepted, with no whitespace normalization.
const release =
  platformCommit.length === 40 && /^[0-9a-f]{40}$/.test(platformCommit)
    ? platformCommit
    : 'unknown';
writeFileSync(
  join(dist, 'build-receipt.json'),
  `${JSON.stringify({ receipt_schema: 1, release, surface: 'web' })}\n`,
);
