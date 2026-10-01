import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * Hiding from assistive technology has one spelling: `decorativeHidden()`
 * (`components/a11yHidden.ts`). Two defects shared that choke point:
 *
 * - **#3009.** react-native-web 0.21 drops `accessibilityElementsHidden` and
 *   `importantForAccessibility`, so an element hidden with only those was
 *   still read aloud by a web screen reader. Any hand-written hide -- those two
 *   props, or a bare `aria-hidden` beside them -- is flagged, wherever it sits;
 *   the helper carries `aria-hidden` for the web and both native props for
 *   iOS and Android. `importantForAccessibility="no"` stays legal: it is the
 *   un-group-a-leaf idiom (RadioOption's described-by hint, a sheet backdrop
 *   that is already `focusable={false}`), not a decorative hide. A loose
 *   `'no-hide-descendants'` literal outside the helper is flagged too, since
 *   it can only be feeding a hand-written hide.
 * - **#2829.** On the web, a lucide-react-native or react-native-svg element
 *   forwards every unknown prop to its `<svg>` and paths, so `accessible`
 *   (and either native-only hide prop) became an invalid DOM attribute and a
 *   React console error. Those props are flagged on any tag the file binds
 *   from either package: a named, aliased, default or namespace import, and,
 *   in a file importing from them, a capitalised name destructured from an
 *   object (`const { Icon } = action`, `({ icon: Icon })`) or picked between
 *   glyphs (`const Glyph = done ? DoorOpen : ChevronRight`). Spreading the
 *   helper on a glyph is fine: on the web it is `aria-hidden` alone.
 *
 * A per-file parse cannot follow an icon passed to another file as a prop and
 * rendered there under an unrelated name; that remains a review step.
 */

const SRC = path.resolve(__dirname, '..', '..');
const HELPER_FILE = path.join(SRC, 'components', 'a11yHidden.ts');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

/** Packages whose web build forwards unknown props to the DOM `<svg>`. */
const SVG_MODULES = new Set(['lucide-react-native', 'react-native-svg']);
/** Props that are React Native-only: on an svg element the web DOM receives them verbatim. */
const NATIVE_ONLY_A11Y_PROPS = new Set([
  'accessible',
  'accessibilityElementsHidden',
  'importantForAccessibility',
]);
/** Hand-written hides; `decorativeHidden()` is their only legal source. */
const HAND_WRITTEN_HIDES = new Set(['aria-hidden', 'accessibilityHidden']);
const NATIVE_ONLY_HIDE = 'accessibilityElementsHidden';
const IMPORTANT_FOR_A11Y = 'importantForAccessibility';
/** The one `importantForAccessibility` value that un-groups rather than hides. */
const UNGROUP_VALUE = 'no';
const HIDE_SUBTREE_LITERAL = 'no-hide-descendants';
const CAPITALISED = /^[A-Z]/u;

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

/** The local names a file binds to svg-rendering components. */
interface GlyphBindings {
  readonly names: Set<string>;
  readonly namespaces: Set<string>;
}

function svgImport(statement: ts.Statement): ts.ImportClause | undefined {
  if (!ts.isImportDeclaration(statement)) return undefined;
  const from = statement.moduleSpecifier;
  if (!ts.isStringLiteral(from) || !SVG_MODULES.has(from.text)) return undefined;
  return statement.importClause;
}

function addImportBindings(clause: ts.ImportClause, bindings: GlyphBindings): void {
  if (clause.name !== undefined) bindings.names.add(clause.name.text);
  const named = clause.namedBindings;
  if (named === undefined) return;
  if (ts.isNamespaceImport(named)) {
    bindings.namespaces.add(named.name.text);
    return;
  }
  named.elements.forEach((element) => bindings.names.add(element.name.text));
}

/** Whether `node` mentions any name already known to be a glyph. */
function mentionsGlyph(node: ts.Node, bindings: GlyphBindings): boolean {
  if (ts.isIdentifier(node) && bindings.names.has(node.text)) return true;
  return ts.forEachChild(node, (child) => mentionsGlyph(child, bindings) || undefined) ?? false;
}

/** A capitalised local that carries a glyph component in a file that imports glyphs. */
function addLocalGlyphs(node: ts.Node, bindings: GlyphBindings): void {
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    if (CAPITALISED.test(node.name.text) && ts.isObjectBindingPattern(node.parent)) {
      bindings.names.add(node.name.text);
    }
  } else if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    CAPITALISED.test(node.name.text) &&
    node.initializer !== undefined &&
    mentionsGlyph(node.initializer, bindings)
  ) {
    bindings.names.add(node.name.text);
  }
  ts.forEachChild(node, (child) => addLocalGlyphs(child, bindings));
}

function collectGlyphBindings(file: ts.SourceFile): GlyphBindings {
  const bindings: GlyphBindings = { names: new Set(), namespaces: new Set() };
  const clauses = file.statements.map(svgImport).filter((clause) => clause !== undefined);
  clauses.forEach((clause) => addImportBindings(clause, bindings));
  if (clauses.length > 0) addLocalGlyphs(file, bindings);
  return bindings;
}

function isGlyphTag(tag: ts.JsxTagNameExpression, bindings: GlyphBindings): boolean {
  if (ts.isIdentifier(tag)) return bindings.names.has(tag.text);
  return (
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    (bindings.namespaces.has(tag.expression.text) || bindings.names.has(tag.expression.text))
  );
}

function isUngroupLiteral(attribute: ts.JsxAttribute): boolean {
  const value = attribute.initializer;
  return value !== undefined && ts.isStringLiteral(value) && value.text === UNGROUP_VALUE;
}

/** Why one attribute breaks the rules, or null when it does not. */
function attributeReason(attribute: ts.JsxAttribute, glyph: boolean): string | null {
  const name = attribute.name.getText();
  if (glyph && NATIVE_ONLY_A11Y_PROPS.has(name)) return 'reaches the DOM';
  if (name === NATIVE_ONLY_HIDE) return 'native-only hide';
  if (name === IMPORTANT_FOR_A11Y && !isUngroupLiteral(attribute)) return 'native-only hide';
  if (HAND_WRITTEN_HIDES.has(name)) return 'hand-written hide';
  return null;
}

function elementHits(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  bindings: GlyphBindings,
  file: ts.SourceFile,
): string[] {
  const glyph = isGlyphTag(element.tagName, bindings);
  const tag = element.tagName.getText(file);
  return element.attributes.properties.flatMap((property) => {
    if (!ts.isJsxAttribute(property)) return [];
    const reason = attributeReason(property, glyph);
    if (reason === null) return [];
    const { line } = file.getLineAndCharacterOfPosition(property.getStart(file));
    return [`${line + 1}: <${tag}> ${property.name.getText(file)}: ${reason}`];
  });
}

function insideJsxAttribute(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) return true;
  }
  return false;
}

function literalHit(node: ts.Node, file: ts.SourceFile): string[] {
  if (!ts.isStringLiteralLike(node) || node.text !== HIDE_SUBTREE_LITERAL) return [];
  if (insideJsxAttribute(node)) return [];
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return [`${line + 1}: '${HIDE_SUBTREE_LITERAL}': subtree literal`];
}

/** Every `line: <Tag> prop: reason` in `source` that hides by hand or leaks a prop to an svg. */
export function findHidingViolations(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const bindings = collectGlyphBindings(file);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      hits.push(...elementHits(node, bindings, file));
    }
    hits.push(...literalHit(node, file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

const scan = (source: string): string[] => findHidingViolations('fixture.tsx', source);

describe('findHidingViolations -- native-only hides (#3009)', () => {
  it('flags accessibilityElementsHidden and a hiding importantForAccessibility', () => {
    expect(scan(`<View accessibilityElementsHidden />;`)).toEqual([
      '1: <View> accessibilityElementsHidden: native-only hide',
    ]);
    expect(scan(`<Text importantForAccessibility="no-hide-descendants">x</Text>;`)).toEqual([
      '1: <Text> importantForAccessibility: native-only hide',
    ]);
  });

  it('reads a tag across lines and past arrow functions, reporting the prop line', () => {
    const source = [
      'const a = 1;',
      '<Text',
      '  onPress={() => a > 0}',
      '  importantForAccessibility={a > 0 ? "auto" : "no-hide-descendants"}',
      '>',
      '  x',
      '</Text>;',
    ].join('\n');
    expect(scan(source)).toEqual(['4: <Text> importantForAccessibility: native-only hide']);
  });

  it('closes the aria-hidden loophole: a hand-written hide is flagged even beside aria-hidden', () => {
    expect(scan(`<View aria-hidden={false} accessibilityElementsHidden />;`)).toEqual([
      '1: <View> aria-hidden: hand-written hide',
      '1: <View> accessibilityElementsHidden: native-only hide',
    ]);
    expect(scan(`<View aria-hidden />;`)).toEqual(['1: <View> aria-hidden: hand-written hide']);
    expect(scan(`<View accessibilityHidden />;`)).toEqual([
      '1: <View> accessibilityHidden: hand-written hide',
    ]);
  });

  it('flags a loose no-hide-descendants literal feeding a hand-written hide', () => {
    expect(scan(`const mode = hidden ? 'no-hide-descendants' : 'auto';`)).toEqual([
      "1: 'no-hide-descendants': subtree literal",
    ]);
  });

  it('accepts the helper spread and the un-group value "no"', () => {
    expect(scan(`<View {...decorativeHidden()} />;`)).toEqual([]);
    expect(scan(`<View {...decorativeHidden(!visible)} />;`)).toEqual([]);
    expect(scan(`<Text importantForAccessibility="no">hint</Text>;`)).toEqual([]);
  });
});

describe('findHidingViolations -- native-only props on a web svg (#2829)', () => {
  it('flags accessible on a named, aliased or default-imported glyph', () => {
    const source = [
      "import Svg, { Path } from 'react-native-svg';",
      "import { X, Check as Tick } from 'lucide-react-native';",
      '<X accessible={false} />;',
      '<Tick accessible={false} />;',
      '<Svg accessible={false} />;',
      '<Path accessibilityElementsHidden />;',
      '<Path importantForAccessibility="no" />;',
    ].join('\n');
    expect(scan(source)).toEqual([
      '3: <X> accessible: reaches the DOM',
      '4: <Tick> accessible: reaches the DOM',
      '5: <Svg> accessible: reaches the DOM',
      '6: <Path> accessibilityElementsHidden: reaches the DOM',
      '7: <Path> importantForAccessibility: reaches the DOM',
    ]);
  });

  it('follows a namespace import and its member tags', () => {
    const source = [
      "import * as Icons from 'lucide-react-native';",
      "import Svg from 'react-native-svg';",
      '<Icons.X accessible />;',
      '<Svg.Path accessible={false} />;',
    ].join('\n');
    expect(scan(source)).toEqual([
      '3: <Icons.X> accessible: reaches the DOM',
      '4: <Svg.Path> accessible: reaches the DOM',
    ]);
  });

  it('follows a glyph destructured from an object or picked between glyphs', () => {
    const source = [
      "import { ChevronRight, DoorOpen, type LucideIcon } from 'lucide-react-native';",
      'const { Icon } = action;',
      '<Icon accessible={false} />;',
      'const Row = ({ icon: Glyph }: { icon: LucideIcon }) => <Glyph accessible={false} />;',
      'const Next = done ? DoorOpen : ChevronRight;',
      '<Next accessible={false} />;',
    ].join('\n');
    expect(scan(source)).toEqual([
      '3: <Icon> accessible: reaches the DOM',
      '4: <Glyph> accessible: reaches the DOM',
      '6: <Next> accessible: reaches the DOM',
    ]);
  });

  it('leaves containers, glyph-free files and the helper spread on a glyph alone', () => {
    const glyphs = "import { X } from 'lucide-react-native';\n";
    // react-native-web drops `accessible` on View, Pressable and Text.
    expect(scan(`${glyphs}<View accessible={false} />;`)).toEqual([]);
    expect(scan(`${glyphs}<X {...decorativeHidden()} />;`)).toEqual([]);
    // Without an svg import, a destructured capital is not presumed to be a glyph.
    expect(scan(`const { Icon } = props;\n<Icon accessible={false} />;`)).toEqual([]);
  });
});

describe('the tree hides by one spelling and leaks nothing to a web svg', () => {
  it('scans the app source, including .tsx, and skips the helper and test folders', () => {
    const files = walk(SRC);
    expect(files).toContain(path.join(SRC, 'components', 'drawer', 'DrawerToggle.tsx'));
    expect(files).toContain(HELPER_FILE);
    expect(files.some((file) => file.split(path.sep).includes('__tests__'))).toBe(false);
  });

  it('finds no hand-written hide and no native-only prop on a glyph anywhere in src', () => {
    const offenders = walk(SRC)
      .filter((file) => file !== HELPER_FILE)
      .flatMap((file) =>
        findHidingViolations(file, fs.readFileSync(file, 'utf-8')).map(
          (hit) => `${path.relative(SRC, file)}:${hit}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
