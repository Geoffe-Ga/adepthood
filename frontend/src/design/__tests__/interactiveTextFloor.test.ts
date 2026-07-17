/* eslint-env jest */
/* global describe, it, expect */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { StyleSheet } from 'react-native';

import { INTERACTIVE_TEXT_MIN } from '../tokens';

import journalEntryStyles from '@/features/Journal/JournalEntry.styles';
import { journalHeroStyles } from '@/features/Journal/JournalHero.styles';
import statTileStyles from '@/features/Journal/StatTile.styles';
import { welcomeStyles } from '@/features/Welcome/Welcome.styles';

/**
 * Guard for the minimum interactive text size.
 *
 * editorialType.caption is 13px, which sits below the tappable-text floor:
 * text a reader is meant to tap or press needs to read as legible chrome, not
 * a fine-print footnote. Interactive labels (links, buttons, chips, dismiss
 * and accept affordances, and similar tappable text) must use
 * editorialType.action (16px, the same size as the ui button face) instead.
 * Genuine non-interactive captions -- timestamps, eyebrows, section labels,
 * hints, and explainer copy that is not itself tappable -- may keep the 13px
 * caption face.
 *
 * Part A walks every source file for editorialType.caption usages and diffs
 * the found set against a hardcoded, manually audited allowlist. An entry in
 * the allowlist below asserts that a human looked at that usage and confirmed
 * it is not interactive. Any new caption usage -- whether interactive or
 * not -- will change the found set and fail this test, forcing a conscious
 * re-audit rather than a silent regression.
 */

// __dirname -> frontend/src/design/__tests__; climb to frontend/src.
const SRC_ROOT = path.join(__dirname, '..', '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      if (entry.name.includes('.test.')) continue;
      files.push(fullPath);
    }
  }
  return files;
}

const CAPTION_USAGE = /\.\.\.editorialType\.caption\b/;
const SAME_LINE_KEY = /([A-Za-z_$][\w$]*)\s*:\s*\{/;
const PRECEDING_KEY = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/;

/** The enclosing style-object key for a caption-usage line, or null if none is found. */
function resolveKey(lines: string[], lineIndex: number): string | null {
  const sameLineMatch = SAME_LINE_KEY.exec(lines[lineIndex] ?? '');
  if (sameLineMatch) return sameLineMatch[1] ?? null;
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const precedingMatch = PRECEDING_KEY.exec(lines[i] ?? '');
    if (precedingMatch) return precedingMatch[1] ?? null;
  }
  return null;
}

function collectCaptionUsageIds(): string[] {
  const ids: string[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    if (file === __filename) continue;
    const relPath = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!CAPTION_USAGE.test(line)) return;
      const key = resolveKey(lines, index);
      ids.push(`${relPath}::${key ?? '(unknown)'}`);
    });
  }
  return ids;
}

// Manually audited: every caption usage below was confirmed NON-interactive
// (a timestamp, eyebrow, section label, hint, or explainer -- never tappable
// text). Sorted to match the sorted found-set comparison.
const AUDITED_NON_INTERACTIVE_CAPTIONS = [
  'components/care/CareResourceCard.tsx::resourceWhat',
  'components/drawer/DrawerSearch.tsx::resultCount',
  'features/Course/Course.styles.ts::readerEyebrow',
  'features/Course/Course.styles.ts::sectionBandLabel',
  'features/Course/Course.styles.ts::stageCoverEyebrow',
  'features/Course/Course.styles.ts::stageCoverProgressLabel',
  'features/Journal/CompletionSuggestionNote.tsx::streak',
  'features/Journal/JournalEntry.styles.ts::aspectChordSectionLabel',
  'features/Journal/JournalEntry.styles.ts::loadErrorText',
  'features/Journal/JournalEntry.styles.ts::marginError',
  'features/Journal/JournalEntry.styles.ts::privacyResonanceReason',
  'features/Journal/JournalEntry.styles.ts::privacyTierExplainer',
  'features/Journal/JournalEntry.styles.ts::savedHint',
  'features/Journal/JournalHero.styles.ts::eyebrow',
  'features/Journal/JournalShelf.styles.ts::cardCaption',
  'features/Journal/JournalShelf.styles.ts::cardDate',
  'features/Journal/JournalShelf.styles.ts::promptLabel',
  'features/Journal/JournalShelf.styles.ts::sectionHeading',
  'features/Journal/MarginNote.tsx::kind',
  'features/Journal/MarginNote.tsx::staleCaption',
  'features/Journal/ReflectionInvitationBand.tsx::label',
  'features/Journal/ReflectionSourcesPanel.tsx::groupHeading',
  'features/Journal/ReflectionSourcesPanel.tsx::levelLabel',
  'features/Journal/ReflectionSourcesPanel.tsx::promoteHint',
  'features/Journal/ReflectionSourcesPanel.tsx::rowExcerpt',
  'features/Journal/ResonanceEssayModal.tsx::kind',
  'features/Journal/SearchBar.tsx::searchResultCount',
  'features/Journal/StatTile.styles.ts::title',
  'features/Practice/PracticeScreen.tsx::heroEyebrow',
  'features/Practice/components/ModePicker.tsx::categoryBlurb',
  'features/Practice/components/ModePicker.tsx::rowDescription',
  'features/Practice/configurator/RitualConfiguratorSheet.tsx::aspectText',
  'features/Practice/configurator/RitualConfiguratorSheet.tsx::headerSubtitle',
  'features/Practice/configurator/forms/CardMeditationForm.tsx::photoError',
  'features/Practice/configurator/forms/CardMeditationForm.tsx::photoNote',
  'features/Practice/configurator/forms/CardMeditationForm.tsx::sectionTitle',
  'features/Practice/configurator/forms/CardMeditationForm.tsx::summaryCount',
  'features/Practice/configurator/forms/CardMeditationForm.tsx::summaryDescription',
  'features/Practice/configurator/forms/IntervalBellForm.tsx::subLabel',
  'features/Practice/screens/CreatePracticeWizard.tsx::entryCardSubtitle',
  'features/Practice/screens/CreatePracticeWizard.tsx::fieldHelp',
  'features/Practice/screens/CreatePracticeWizard.tsx::indicatorStep',
  'features/Practice/screens/CreatePracticeWizard.tsx::noticeText',
  'features/Practice/screens/PracticeDetailScreen.tsx::eyebrow',
  'features/Return/MettaSessionModal.tsx::weekTitle',
  'features/Settings/SupportCareScreen.tsx::limits',
  'features/Welcome/Welcome.styles.ts::eyebrow',
  'features/Welcome/Welcome.styles.ts::note',
].sort();

describe('interactive text floor', () => {
  describe('caption usage allowlist', () => {
    it('matches the audited non-interactive set exactly (a superset means an unaudited or unmigrated interactive usage)', () => {
      const found = collectCaptionUsageIds().sort();
      expect(found).toEqual(AUDITED_NON_INTERACTIVE_CAPTIONS);
    });
  });

  describe('migrated interactive style pins', () => {
    it('sizes the JournalEntry interactive labels to the floor', () => {
      const controlLink = StyleSheet.flatten(journalEntryStyles.controlLink);
      const privacyTierLabel = StyleSheet.flatten(journalEntryStyles.privacyTierLabel);
      const aspectChordTriggerLabel = StyleSheet.flatten(
        journalEntryStyles.aspectChordTriggerLabel,
      );
      const aspectChordChipLabel = StyleSheet.flatten(journalEntryStyles.aspectChordChipLabel);
      const aspectChordClearLabel = StyleSheet.flatten(journalEntryStyles.aspectChordClearLabel);
      expect(controlLink.fontSize).toBe(INTERACTIVE_TEXT_MIN);
      expect(privacyTierLabel.fontSize).toBe(INTERACTIVE_TEXT_MIN);
      expect(aspectChordTriggerLabel.fontSize).toBe(INTERACTIVE_TEXT_MIN);
      expect(aspectChordChipLabel.fontSize).toBe(INTERACTIVE_TEXT_MIN);
      expect(aspectChordClearLabel.fontSize).toBe(INTERACTIVE_TEXT_MIN);
    });

    it('sizes the StatTile cue to the floor', () => {
      const cue = StyleSheet.flatten(statTileStyles.cue);
      expect(cue.fontSize).toBe(INTERACTIVE_TEXT_MIN);
    });

    it('sizes the JournalHero positionCue to the floor', () => {
      const positionCue = StyleSheet.flatten(journalHeroStyles.positionCue);
      expect(positionCue.fontSize).toBe(INTERACTIVE_TEXT_MIN);
    });

    it('sizes the Welcome skipLabel to the floor', () => {
      const skipLabel = StyleSheet.flatten(welcomeStyles.skipLabel);
      expect(skipLabel.fontSize).toBe(INTERACTIVE_TEXT_MIN);
    });
  });
});
