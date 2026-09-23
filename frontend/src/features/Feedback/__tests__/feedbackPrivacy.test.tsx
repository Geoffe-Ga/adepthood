/* eslint-env jest */
/* global describe, it, expect, jest, beforeEach, afterEach */
/**
 * AC10: nothing the tester wrote reaches a log or the crash reporter, and the
 * package has no way to attach a screenshot, the clipboard or a console buffer.
 *
 * Two halves. The static half reads every production source file of the
 * reporter and checks what it imports and how it calls `console`. The runtime
 * half drives real failed sends through the real request layer (only `fetch` is
 * faked) with a sentinel in the summary, and watches every console channel and
 * the Sentry entry point for it.
 */
import * as fs from 'fs';
import * as path from 'path';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen } from '@testing-library/react-native';
import * as ts from 'typescript';

import { renderComposer } from './composerHarness';

import { FEEDBACK_TEST_IDS as IDS } from '@/features/Feedback/feedbackTestIds';
import * as sentry from '@/observability/sentry';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';

jest.mock('@/config', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/config'),
  API_BASE_URL: 'http://test',
}));

const SRC = path.resolve(__dirname, '..', '..', '..');
const FEEDBACK_DIR = path.join(SRC, 'features', 'Feedback');
const EXTRA_FILES = [path.join(SRC, 'storage', 'feedbackDraftStorage.ts')];

function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const FILES = [...productionFiles(FEEDBACK_DIR), ...EXTRA_FILES];

const FORBIDDEN_IMPORT =
  /clipboard|view-shot|screen-?capture|screenshot|@sentry|observability\/sentry/i;
const FORBIDDEN_CONSOLE = new Set(['log', 'info', 'debug', 'trace', 'dir', 'table']);
/** The only thing a console call in this package may pass: a fixed string or a WARN_ constant. */
const isFixedArgument = (arg: ts.Expression): boolean =>
  ts.isStringLiteral(arg) ||
  ts.isNoSubstitutionTemplateLiteral(arg) ||
  (ts.isIdentifier(arg) && /^WARN_[A-Z_]+$/.test(arg.text));

interface ConsoleCall {
  file: string;
  method: string;
  fixed: boolean;
}

function scan(file: string): { imports: string[]; consoleCalls: ConsoleCall[] } {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  const consoleCalls: ConsoleCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console'
    ) {
      consoleCalls.push({
        file: path.relative(SRC, file),
        method: node.expression.name.text,
        fixed: node.arguments.every(isFixedArgument),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, consoleCalls };
}

describe('the reporter package, statically', () => {
  it('scans a real, non-empty set of files', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
    expect(FILES.some((f) => f.endsWith('FeedbackComposerScreen.tsx'))).toBe(true);
  });

  it('imports no clipboard, screenshot, screen-capture or crash-reporter module', () => {
    const offenders = FILES.flatMap((file) =>
      scan(file)
        .imports.filter((spec) => FORBIDDEN_IMPORT.test(spec))
        .map((spec) => `${path.relative(SRC, file)} -> ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never logs at log/info/debug, and only ever logs fixed strings', () => {
    const calls = FILES.flatMap((file) => scan(file).consoleCalls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => FORBIDDEN_CONSOLE.has(c.method))).toEqual([]);
    expect(calls.filter((c) => !c.fixed)).toEqual([]);
  });
});

const SENTINEL = 'SENTINEL-private-words';

function jsonResponse(data: unknown, status: number, requestId?: string) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'X-Request-ID' ? (requestId ?? null) : null) },
    json: () => Promise.resolve(data),
  });
}

describe('the reporter at runtime', () => {
  const channels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  let spies: jest.SpyInstance[] = [];
  let report: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;
  let randomSpy: jest.SpyInstance;

  beforeEach(async () => {
    _resetSerializedWriteForTests();
    setActiveUser(1);
    await AsyncStorage.clear();
    spies = channels.map((c) => jest.spyOn(console, c).mockImplementation(() => undefined));
    report = jest.spyOn(sentry, 'reportException').mockImplementation(() => undefined);
    // Pins the request layer's jittered backoff to its floor so a retried 5xx stays fast.
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    report.mockRestore();
    fetchSpy.mockRestore();
    randomSpy.mockRestore();
    setActiveUser(null);
  });

  function leaked(): boolean {
    const everything = [...spies, report].flatMap((spy) => spy.mock.calls);
    return everything.some((args) =>
      args.some((arg: unknown) => {
        const text =
          arg instanceof Error ? `${arg.message} ${String(arg.stack)}` : JSON.stringify(arg);
        return (text ?? '').includes(SENTINEL);
      }),
    );
  }

  it.each([
    ['a 422', () => jsonResponse({ detail: [{ msg: 'bad', input: SENTINEL }] }, 422)],
    [
      'a 500 with a request id',
      () => jsonResponse({ error: 'internal_error', request_id: 'r-1' }, 500, 'r-1'),
    ],
    ['a 201 whose receipt fails validation', () => jsonResponse({ public_id: 'nope' }, 201)],
    ['a dropped connection', () => Promise.reject(new TypeError('Network request failed'))],
  ])('%s leaves no trace of the summary in any log', async (_name, respond) => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(respond as () => Promise<Response>);
    renderComposer({ control: 'shell.header.send_feedback' });
    await screen.findByTestId(IDS.categoryOption('idea'));
    fireEvent.press(screen.getByTestId(IDS.categoryOption('idea')));
    fireEvent.changeText(screen.getByTestId(IDS.field('summary')), SENTINEL);
    fireEvent.changeText(screen.getByTestId(IDS.field('intent')), `${SENTINEL} intent`);

    await act(async () => {
      fireEvent.press(screen.getByTestId(IDS.send));
    });
    await screen.findByTestId(IDS.status);

    expect(fetchSpy).toHaveBeenCalled();
    expect(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)).toContain(SENTINEL);
    expect(leaked()).toBe(false);
  });
});
