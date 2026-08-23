import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';
import { StyleSheet } from 'react-native';
import type { TextStyle } from 'react-native';

import { journalHeroStyles } from '../JournalHero.styles';
import shelfStyles from '../JournalShelf.styles';
import statTileStyles from '../StatTile.styles';

import { editorialType, ink } from '@/design/tokens';

/**
 * The Journal home screen's type hierarchy, pinned.
 *
 * The shelf reads as a quiet editorial library only while emphasis stays rare.
 * Nothing in the type tokens stops a feature style file from reaching for
 * ``heading`` or ``uppercase`` again, and each single reach looks harmless --
 * the loudness is emergent, six blocks each announcing themselves. So the
 * budget is asserted here rather than left to review: one tracked small-caps
 * role for the list's spine, one voice above the reading face per block, and
 * the writer's own title at reading weight.
 *
 * The scan is over source text because two of the six surfaces keep their
 * styles module-private inside the component file; a stylesheet-only pin would
 * silently cover four of them and call that the screen.
 */

// __dirname -> frontend/src/features/Journal/__tests__; climb to the feature.
const FEATURE_ROOT = path.join(__dirname, '..');

/** The surfaces `ShelfTopMatter` stacks, plus the list and screen themselves. */
const HOME_STACK = [
  'JournalHero.styles.ts',
  'StatTile.styles.ts',
  'JournalShelf.styles.ts',
  'MorningPagesTip.tsx',
  'ReflectionInvitationBand.tsx',
  'JournalShelfScreen.tsx',
];

const UPPERCASE_USAGE = /textTransform:\s*'uppercase'/;
const EMPHATIC_FACE = /\.\.\.editorialType\.(title|display|heading)\b/;
const SAME_LINE_KEY = /([A-Za-z_$][\w$]*)\s*:\s*\{/;
const PRECEDING_KEY = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/;

/** The enclosing style-object key for a matched line, or null if none is found. */
function resolveKey(lines: string[], lineIndex: number): string | null {
  const sameLine = SAME_LINE_KEY.exec(lines[lineIndex] ?? '');
  if (sameLine) return sameLine[1] ?? null;
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const preceding = PRECEDING_KEY.exec(lines[i] ?? '');
    if (preceding) return preceding[1] ?? null;
  }
  return null;
}

/** `file::styleKey` for every line of the home stack matching `pattern`. */
function usagesMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of HOME_STACK) {
    const lines = readFileSync(path.join(FEATURE_ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      found.push(`${file}::${resolveKey(lines, index) ?? '(unknown)'}`);
    });
  }
  return found.sort();
}

describe('the Journal home screen reads as a library, not a stack of headings', () => {
  it('spends its one tracked small-caps role on the list spine and nowhere else', () => {
    // Uppercase + tracking is the strongest "this is a header" signal in the
    // vocabulary. It marks the recency spine (This week / This month / Earlier)
    // and nothing else, so each band stops announcing itself.
    expect(usagesMatching(UPPERCASE_USAGE)).toEqual(['JournalShelf.styles.ts::sectionHeading']);
  });

  it('gives each block one voice above the reading face, and the hero the only larger one', () => {
    expect(usagesMatching(EMPHATIC_FACE)).toEqual([
      // The one title-scale moment in the first screenful.
      'JournalHero.styles.ts::greeting',
      // One emphatic line per band; the labels beneath them recede to caption.
      'JournalShelf.styles.ts::promptQuestion',
      'MorningPagesTip.tsx::title',
      'ReflectionInvitationBand.tsx::title',
      'StatTile.styles.ts::stat',
    ]);
  });

  it('sets an entry card in reading weight so the writing, not the chrome, is the loud part', () => {
    const title = StyleSheet.flatten(shelfStyles.cardTitle);
    const excerpt = StyleSheet.flatten(shelfStyles.cardExcerpt);

    expect(title.fontSize).toBe(editorialType.body.fontSize);
    expect(title.fontWeight).toBe('400');
    expect(title.color).toBe(ink.primary);
    // The excerpt is untouched: the separation now reads through colour and
    // line count, the way a book index does it, not through weight.
    expect(excerpt.fontSize).toBe(editorialType.note.fontSize);
    expect(excerpt.color).toBe(ink.soft);
  });

  it('keeps the hero eyebrow and the stat labels as quiet sentence-case captions', () => {
    // Widened to `TextStyle`: the flattened literal type cannot express the
    // absence of a property that was just removed from it.
    const eyebrow: TextStyle = StyleSheet.flatten(journalHeroStyles.eyebrow);
    const statLabel: TextStyle = StyleSheet.flatten(statTileStyles.title);

    expect(eyebrow.fontSize).toBe(editorialType.caption.fontSize);
    expect(eyebrow.textTransform).toBeUndefined();
    expect(eyebrow.letterSpacing).toBeUndefined();
    expect(statLabel.textTransform).toBeUndefined();
  });

  it('does not repeat the screen name the bottom tab already carries', () => {
    const screen = readFileSync(path.join(FEATURE_ROOT, 'JournalShelfScreen.tsx'), 'utf8');
    // `ScreenHeader` renders `type(width).display` -- 34/700 on a phone, a
    // second display moment directly under the hero greeting.
    expect(screen).not.toMatch(/ScreenHeader/);
  });
});
