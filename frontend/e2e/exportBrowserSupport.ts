import { readFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

export interface BrowserExport {
  contents: string;
  suggestedFilename: string;
}

interface DataExportArchive {
  format: string;
  format_version: number;
  records: { journal_entries: unknown[] };
}

/** Download one export through the real screen and retain its browser-facing name. */
export async function exportThroughScreen(page: Page, testId: string): Promise<BrowserExport> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testId).click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error(`${testId} produced no readable browser download`);
  await expect(page.getByTestId('export-data-receipt')).toBeVisible();
  return {
    contents: readFileSync(path, 'utf8'),
    suggestedFilename: download.suggestedFilename(),
  };
}

/** Prove the JSON download is a real archive carrying the expected journal row. */
export function expectJsonExport(
  downloaded: BrowserExport,
  expected: { title: string; message: string },
): void {
  expect(downloaded.suggestedFilename).toMatch(/^adepthood-export-\d{4}-\d{2}-\d{2}\.json$/u);
  const archive = JSON.parse(downloaded.contents) as DataExportArchive;
  expect(archive.format).toBe('adepthood-export');
  expect(archive.format_version).toBeGreaterThan(0);
  expect(archive.records.journal_entries).toEqual(
    expect.arrayContaining([expect.objectContaining(expected)]),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Prove the Markdown download is readable prose with the expected entry structure. */
export function expectMarkdownExport(
  downloaded: BrowserExport,
  expected: { title: string; message: string },
): void {
  expect(downloaded.suggestedFilename).toMatch(/^adepthood-journal-\d{4}-\d{2}-\d{2}\.md$/u);
  expect(downloaded.contents).toMatch(/^# Your Adepthood journal\n\n/u);
  expect(downloaded.contents).toMatch(
    new RegExp(`^## \\d{4}-\\d{2}-\\d{2} — ${escapeRegExp(expected.title)}$`, 'mu'),
  );
  expect(downloaded.contents).toContain(`\n\n${expected.message}\n\n---\n`);
}
