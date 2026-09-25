import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * No confirmation may be asked through ``Alert.alert`` (#2928).
 *
 * react-native-web ships ``Alert`` as ``class Alert { static alert() {} }``, so
 * on web the buttons a confirm passes never render and their ``onPress`` never
 * runs: "Remove key", vault Disconnect and vault Replace all did nothing there
 * while the unit tests, which spied on ``Alert.alert`` and fired the button by
 * hand, stayed green. A confirm belongs in the rendered ``ConfirmDialog``.
 *
 * The guard parses each source file rather than grepping it, because the calls
 * it hunts span lines: a single-line pattern returned zero hits against the very
 * code this issue fixed. Informational ``Alert.alert(title, message)`` calls
 * are not confirms and are left alone; any call carrying the third, buttons,
 * argument is flagged, as is an ``AlertButton`` import.
 */

const SRC = path.resolve(__dirname, '..', '..');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);
/** ``Alert.alert(title, message, buttons, ...)``: the buttons are argument three. */
const BUTTONS_ARGUMENT_COUNT = 3;

const isSourceFile = (name: string): boolean =>
  /\.tsx?$/u.test(name) && !/\.(test|spec)\.tsx?$/u.test(name);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...walk(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function isAlertAlertCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Alert' &&
    callee.name.text === 'alert'
  );
}

function importsAlertButton(node: ts.Node): boolean {
  if (!ts.isImportDeclaration(node)) return false;
  const bindings = node.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.some((element) => element.name.text === 'AlertButton');
}

/** Every ``line: reason`` in ``source`` that asks a confirm through Alert. */
export function findAlertConfirms(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (isAlertAlertCall(node) && node.arguments.length >= BUTTONS_ARGUMENT_COUNT) {
      hits.push(`${lineOf(node)}: Alert.alert with buttons`);
    } else if (importsAlertButton(node)) {
      hits.push(`${lineOf(node)}: AlertButton import`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

// The multiline shape ApiKeySettingsScreen shipped before #2928.
const MULTILINE_CONFIRM = `
import { Alert } from 'react-native';
function useRemoveConfirmation(performClear: () => Promise<void>): () => void {
  return useCallback(() => {
    Alert.alert(
      'Remove API key?',
      'BotMason will fall back to the shared server key.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void performClear() },
      ],
    );
  }, [performClear]);
}
`;

// The shape VaultSettingsScreen shipped: buttons passed by variable, not literal.
const BUTTONS_BY_REFERENCE = `
import { Alert, type AlertButton } from 'react-native';
const buttons: AlertButton[] = [{ text: 'Cancel', style: 'cancel' }];
Alert.alert(prompt.title, prompt.body, buttons);
`;

const INFORMATIONAL = `
import { Alert } from 'react-native';
Alert.alert('Could not save', 'Please try again.');
`;

describe('findAlertConfirms', () => {
  it('flags a multiline Alert.alert confirm with a buttons array', () => {
    expect(findAlertConfirms('fixture.tsx', MULTILINE_CONFIRM)).toEqual([
      '5: Alert.alert with buttons',
    ]);
  });

  it('flags buttons passed by reference and the AlertButton import', () => {
    expect(findAlertConfirms('fixture.tsx', BUTTONS_BY_REFERENCE)).toEqual([
      '2: AlertButton import',
      '4: Alert.alert with buttons',
    ]);
  });

  it('leaves an informational title-and-message alert alone', () => {
    expect(findAlertConfirms('fixture.tsx', INFORMATIONAL)).toEqual([]);
  });
});

describe('no confirm is asked through Alert.alert', () => {
  it('finds no Alert.alert confirm anywhere in src', () => {
    const offenders = walk(SRC).flatMap((file) =>
      findAlertConfirms(file, fs.readFileSync(file, 'utf-8')).map(
        (hit) => `${path.relative(SRC, file)}:${hit}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
