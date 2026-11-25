import { join } from 'node:path';

import { expect, test, type Response } from '@playwright/test';

import { backendUrl } from './journalHabitsBrowserSupport';
import {
  countsLine,
  digestOf,
  expectLanded,
  fileReads,
  importPosts,
  IMPORT_ROUTE,
  loginVaultOwner,
  openSeedScreen,
  recordFileReads,
  recordRequests,
  registerSeedSpec,
  runRow,
  uploadCount,
  uploadOf,
  uploadsSince,
  vaultLedger,
} from './seedBrowserSupport';

/**
 * Loose `.json` files picked one by one, in a real browser (#3797): a
 * conversation export lands, a `.json` that is not one is skipped rather than
 * failed, one past the size cap never leaves, and a `.jsonl` is still not sent.
 *
 * The files go through Chromium's own file chooser, opened by the app's
 * "Choose files" button, and the outcome is read back from the lane's Creek
 * vault through its own ledger. That vault decides a `.json` by what it holds,
 * as Creek does since Creek-Vault#2148: nothing is armed and nothing is stubbed,
 * so the `415 unsupported_source` here is the vault's own answer to the bytes
 * the real server forwarded.
 *
 * Stored outcomes are asserted before absences, so a vault the lane never
 * reached cannot make an absence pass.
 */

/** What the screen says, above the pickers, of the exports that come in as one file. */
const JSON_NOTE =
  'A ChatGPT, Claude or Discord conversation export can come in as its .json file, or as ' +
  'the .zip it arrived in.';

/** A `.json` the vault turned away for what it holds. */
const NOT_AN_EXPORT_LINE =
  'Skipped · this .json is not a conversation export your Corpus reads, so nothing was ' +
  "stored. If it came from ChatGPT, Claude or Discord, send the export's .zip instead.";

/** A `.json` past the one-document cap. */
const TOO_LARGE_LINE =
  'Skipped · larger than 10 MB, which is as much as one document can carry, so it was never ' +
  "sent. If it is a conversation export, send the export's .zip instead.";

/** A type nothing reads, decided on the device. */
const UNSUPPORTED_LINE = "Skipped · your Corpus doesn't read this type";

/** One byte past the one-document cap the device and the server share. */
const OVER_CAP_BYTES = 10 * 1024 * 1024 + 1;

/** A ChatGPT `conversations.json`: a list whose first entry carries `mapping`. */
const CONVERSATIONS = `${JSON.stringify([
  {
    title: 'json sentinel 3797',
    create_time: 1_700_000_000,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['a'] },
      a: {
        id: 'a',
        parent: 'root',
        children: [],
        message: {
          author: { role: 'user' },
          create_time: 1_700_000_000,
          content: { content_type: 'text', parts: ['json sentinel 3797: a question.'] },
        },
      },
    },
  },
])}\n`;

/** A `.json` that is no export at all. */
const PACKAGE = `${JSON.stringify({ name: 'json-sentinel-3797', version: '1.0.0' })}\n`;

const JSON_LINES = '{"json": "sentinel 3797 lines"}\n';

/** Spec-wide scratch space; the files below live here and go with it. */
const { writeFolder } = registerSeedSpec('adepthood-seed-json-');

test('a picked .json export lands, another .json is skipped, and an oversize one never leaves (#3797)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const folder = writeFolder('Loose 3797', {
    'conversations.json': CONVERSATIONS,
    'package.json': PACKAGE,
    'everything.json': Buffer.alloc(OVER_CAP_BYTES, ' '),
    'log.jsonl': JSON_LINES,
  });
  const sent = recordRequests(page);
  await recordFileReads(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);
  await expect(page.getByTestId('seed-json-export-note')).toHaveText(JSON_NOTE);
  const before = await vaultLedger(page);
  // What the real server answered each document it was sent, in order.
  const answers: Promise<{ vault_status: string | null }>[] = [];
  page.on('response', (response: Response) => {
    if (
      response.request().method() === 'POST' &&
      response.url() === `${backendUrl()}${IMPORT_ROUTE}`
    ) {
      answers.push(response.json() as Promise<{ vault_status: string | null }>);
    }
  });

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('seed-choose-button').click();
  await (
    await chooser
  ).setFiles(
    ['conversations.json', 'package.json', 'everything.json', 'log.jsonl'].map((name) =>
      join(folder, name),
    ),
  );

  await expectLanded(page, 'conversations.json');
  await expect(runRow(page, 'package.json')).toContainText(NOT_AN_EXPORT_LINE);
  await expect(runRow(page, 'everything.json')).toContainText(TOO_LARGE_LINE);
  await expect(runRow(page, 'log.jsonl')).toContainText(UNSUPPORTED_LINE);
  await expect(page.getByTestId('seed-summary')).toHaveText(countsLine({ landed: 1, skipped: 3 }));
  await expect(page.getByTestId('seed-retry-button')).toHaveCount(0);

  // Stored outcomes first: the server answered the export accepted and the
  // other `.json` unsupported_source, a 202 in the vault's own word rather
  // than an error; the export was kept, and the other reached the vault and
  // was refused there, storing nothing.
  expect((await Promise.all(answers)).map((answer) => answer.vault_status)).toEqual([
    'accepted',
    'unsupported_source',
  ]);
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(2);
  expect(uploadOf(uploads, digestOf(CONVERSATIONS)).action).toBe('created');
  expect(uploadOf(uploads, digestOf(PACKAGE)).action).toBe('refused');
  expect(after.fragments.map((fragment) => fragment.digest)).toContain(digestOf(CONVERSATIONS));
  // Then the absences: the refused file is held nowhere, and neither the
  // oversize `.json` nor the `.jsonl` was read or posted.
  expect(after.fragments.map((fragment) => fragment.digest)).not.toContain(digestOf(PACKAGE));
  const filenames = importPosts(sent).map(
    (entry) => (JSON.parse(entry.body ?? '{}') as { filename?: string }).filename,
  );
  expect(filenames).toEqual(['conversations.json', 'package.json']);
  expect([...(await fileReads(page))].sort()).toEqual(['conversations.json', 'package.json']);
  expect(after.received.map((entry) => entry.digest)).not.toContain(digestOf(JSON_LINES));
});
