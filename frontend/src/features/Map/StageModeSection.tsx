import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { StageChordNote, StageMode, StagePhaseChord } from '../../api';
import {
  STAGE_COLORS,
  editorialType,
  onShowcase,
  radius,
  showcase,
  spacing,
  uiType,
} from '../../design/tokens';
import { useStageColorName } from '../../store/stageColorName';

// A stage's Mode of the Wavelength, as served. Today only Clear Light states
// one: the Neither/Both Mode, which holds the healthy expression of every other
// Mode. So instead of a scale of integrated/shadow pairs of its own, each phase
// shows a chord: every other stage's integrated name for that phase, sounding
// together. The two labels are the only hand-authored copy; the Mode's name and
// description and every note are canon, rendered as received.
const MODE_LABEL = 'Mode of the Wavelength';
const CHORD_LABEL = 'The chord in each phase';

/** Slug a phase for a testID: lowercased, spaces collapsed to hyphens. */
const phaseSlug = (phase: string): string => phase.toLowerCase().replace(/\s+/g, '-');

/**
 * The colour of the stage a note comes from, so the chord reads as its
 * Frequencies: its served colour, following the store as the stages arrive.
 */
const useNoteColor = (stageNumber: number): string | undefined =>
  STAGE_COLORS[useStageColorName(stageNumber) ?? ''];

/** One note of a chord: its stage's colour dot beside the stage's healthy expression. */
const ChordNote = ({ note, testID }: { note: StageChordNote; testID: string }) => {
  const color = useNoteColor(note.stage_number);
  return (
    <View style={styles.note} testID={testID}>
      <View style={[styles.noteDot, { backgroundColor: color }]} testID={`${testID}-dot`} />
      <Text style={styles.noteName}>{note.name}</Text>
    </View>
  );
};

/** One Wavelength phase: a caption eyebrow over its chord of notes. */
const PhaseChord = ({ chord }: { chord: StagePhaseChord }): React.JSX.Element => {
  const baseTestId = `stage-chord-${phaseSlug(chord.phase)}`;
  return (
    <View style={styles.phaseBlock} testID={baseTestId}>
      <Text style={styles.eyebrow} accessibilityRole="header">
        {chord.phase}
      </Text>
      <View style={styles.notes}>
        {chord.notes.map((note) => (
          <ChordNote
            key={note.stage_number}
            note={note}
            testID={`${baseTestId}-note-${String(note.stage_number)}`}
          />
        ))}
      </View>
    </View>
  );
};

/**
 * The stage-detail Mode surface: the served Mode statement, then (for a Mode
 * that holds all the Modes) its chord in each of the six phases. Renders
 * nothing for a stage that states no Mode, so the nine scale stages keep their
 * integrated/shadow pairs alone.
 */
export const StageModeSection = ({
  mode,
  chord,
}: {
  mode: StageMode | null;
  chord: StagePhaseChord[];
}): React.JSX.Element | null => {
  if (mode === null) {
    return null;
  }
  return (
    <View style={styles.section}>
      <View style={styles.statement} testID="stage-mode">
        <Text style={styles.eyebrow}>{MODE_LABEL}</Text>
        <Text style={styles.modeName}>{mode.name}</Text>
        <Text style={styles.modeDescription}>{mode.description}</Text>
      </View>
      {chord.length > 0 ? (
        <View style={styles.chord} testID="stage-chord">
          <Text style={styles.chordLabel}>{CHORD_LABEL}</Text>
          {chord.map((phaseChord) => (
            <PhaseChord key={phaseChord.phase} chord={phaseChord} />
          ))}
        </View>
      ) : null}
    </View>
  );
};

const EYEBROW_LETTER_SPACING = 0.6;
/** Eyebrows, labels and notes: the caption step of the ramp (#2960). */
const CAPTION_SIZE = editorialType.caption.fontSize;
/** The Mode's name leads its card at the modal's lead-line step. */
const NAME_SIZE = uiType.button.fontSize;
/** A note's colour dot: small enough to read as a key, not a control. */
const DOT_SIZE = 8;

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing(1.5),
    gap: spacing(1.25),
  },
  statement: {
    backgroundColor: showcase.raised,
    borderRadius: radius.md,
    padding: spacing(1),
    gap: spacing(0.5),
  },
  // Small, non-interactive caption eyebrow (the Mode label and each phase).
  eyebrow: {
    fontFamily: editorialType.serif,
    fontSize: CAPTION_SIZE,
    fontWeight: '700',
    letterSpacing: EYEBROW_LETTER_SPACING,
    textTransform: 'uppercase',
    color: onShowcase.soft,
  },
  modeName: {
    fontFamily: editorialType.serif,
    fontSize: NAME_SIZE,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  modeDescription: {
    fontSize: CAPTION_SIZE,
    lineHeight: editorialType.caption.lineHeight,
    color: onShowcase.soft,
  },
  chord: {
    gap: spacing(1.25),
  },
  chordLabel: {
    fontSize: CAPTION_SIZE,
    fontWeight: '600',
    letterSpacing: EYEBROW_LETTER_SPACING,
    color: onShowcase.soft,
  },
  phaseBlock: {
    gap: spacing(0.5),
  },
  notes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing(0.5),
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    gap: spacing(0.5),
    backgroundColor: showcase.raised,
    borderRadius: radius.md,
    paddingVertical: spacing(0.25),
    paddingHorizontal: spacing(0.75),
  },
  noteDot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
  noteName: {
    flexShrink: 1,
    fontSize: CAPTION_SIZE,
    color: onShowcase.primary,
  },
});

/** The section's styles, exported so the Map type-ramp test can audit their sizes (#2960). */
export { styles as stageModeStyles };
