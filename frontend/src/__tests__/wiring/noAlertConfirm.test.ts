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
 * argument is flagged, as is any ``Alert.prompt`` and an ``AlertButton``
 * import. ``Alert`` is followed through an aliased import, a namespace import
 * and ``Alert['alert']``; destructuring ``alert``/``prompt`` off it is flagged
 * outright, since the calls it hides are no longer recognisable as Alert's.
 * Deeper indirection (re-exports, passing Alert through a variable) is out of
 * reach of a per-file scan and is left to review.
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

const REACT_NATIVE = 'react-native';
/** Alert methods whose buttons (or input) never render on web. */
const DIALOG_METHODS = new Set(['alert', 'prompt']);

/** The local names a file binds to react-native's ``Alert`` or to the module. */
interface AlertBindings {
  readonly alerts: Set<string>;
  readonly namespaces: Set<string>;
}

/** The named-or-namespace bindings of a react-native import, or undefined. */
function reactNativeBindings(statement: ts.Statement): ts.NamedImportBindings | undefined {
  if (!ts.isImportDeclaration(statement)) return undefined;
  const from = statement.moduleSpecifier;
  if (!ts.isStringLiteral(from) || from.text !== REACT_NATIVE) return undefined;
  return statement.importClause?.namedBindings;
}

function collectBindings(file: ts.SourceFile): AlertBindings {
  const alerts = new Set<string>(['Alert']);
  const namespaces = new Set<string>();
  for (const bindings of file.statements.map(reactNativeBindings)) {
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    bindings.elements
      .filter((element) => (element.propertyName ?? element.name).text === 'Alert')
      .forEach((element) => alerts.add(element.name.text));
  }
  return { alerts, namespaces };
}

/** ``Alert``, an alias of it, or ``RN.Alert`` through a namespace import. */
function isAlertObject(node: ts.Expression, bindings: AlertBindings): boolean {
  if (ts.isIdentifier(node)) return bindings.alerts.has(node.text);
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'Alert' &&
    ts.isIdentifier(node.expression) &&
    bindings.namespaces.has(node.expression.text)
  );
}

/** The method name of ``Alert.x`` or ``Alert['x']``, or null for anything else. */
function alertMethod(callee: ts.Expression, bindings: AlertBindings): string | null {
  if (ts.isPropertyAccessExpression(callee) && isAlertObject(callee.expression, bindings)) {
    return callee.name.text;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    isAlertObject(callee.expression, bindings)
  ) {
    return callee.argumentExpression.text;
  }
  return null;
}

/** Why a call is a web-dead confirm, or null when it is not one. */
function callReason(node: ts.CallExpression, bindings: AlertBindings): string | null {
  const method = alertMethod(node.expression, bindings);
  if (method === 'prompt') return 'Alert.prompt';
  if (method === 'alert' && node.arguments.length >= BUTTONS_ARGUMENT_COUNT) {
    return 'Alert.alert with buttons';
  }
  return null;
}

/** ``const { alert } = Alert`` hides every later call from the call check. */
function destructuresDialog(node: ts.Node, bindings: AlertBindings): boolean {
  if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return false;
  if (!ts.isObjectBindingPattern(node.name) || !isAlertObject(node.initializer, bindings)) {
    return false;
  }
  return node.name.elements.some((element) => {
    const key = element.propertyName ?? element.name;
    return ts.isIdentifier(key) && DIALOG_METHODS.has(key.text);
  });
}

function importsAlertButton(node: ts.Node): boolean {
  if (!ts.isImportDeclaration(node)) return false;
  const bindings = node.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.some(
    (element) => (element.propertyName ?? element.name).text === 'AlertButton',
  );
}

function nodeReason(node: ts.Node, bindings: AlertBindings): string | null {
  if (ts.isCallExpression(node)) return callReason(node, bindings);
  if (importsAlertButton(node)) return 'AlertButton import';
  if (destructuresDialog(node, bindings)) return 'Alert dialog method destructured';
  return null;
}

/** Every ``line: reason`` in ``source`` that asks a confirm through Alert. */
export function findAlertConfirms(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const bindings = collectBindings(file);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const reason = nodeReason(node, bindings);
    if (reason !== null) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      hits.push(`${line + 1}: ${reason}`);
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

const EVASIONS = `
import { Alert as Dialog } from 'react-native';
import * as RN from 'react-native';
Dialog.alert('t', 'm', [{ text: 'OK' }]);
RN.Alert.alert('t', 'm', [{ text: 'OK' }]);
Dialog['alert']('t', 'm', [{ text: 'OK' }]);
const { alert } = Dialog;
Dialog.prompt('Name?');
Dialog.alert('t', 'm');
`;

// Alert-shaped calls on objects that are not react-native's Alert.
const LOOKALIKES = `
const toast = { alert: (..._args: unknown[]) => undefined };
toast.alert('t', 'm', []);
const { alert } = toast;
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

  it('follows Alert through aliases, namespaces, element access, destructuring and prompt', () => {
    expect(findAlertConfirms('fixture.tsx', EVASIONS)).toEqual([
      '4: Alert.alert with buttons',
      '5: Alert.alert with buttons',
      '6: Alert.alert with buttons',
      '7: Alert dialog method destructured',
      '8: Alert.prompt',
    ]);
  });

  it('ignores alert-shaped calls on objects that are not Alert', () => {
    expect(findAlertConfirms('fixture.tsx', LOOKALIKES)).toEqual([]);
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
