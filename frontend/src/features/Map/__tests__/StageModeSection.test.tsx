/* eslint-env jest */
/* global describe, it, expect */
// Gate 1 contract for Clear Light's stage-detail surface: the Neither/Both Mode
// statement over a chord of every other stage's healthy expression per phase.
import React from 'react';
import { act, create } from 'react-test-renderer';

import type { StageMode, StagePhaseChord } from '../../../api';
import { STAGE_COLORS, STAGE_ORDER } from '../../../design/tokens';
import { StageModeSection } from '../StageModeSection';

import { ranksOrShames } from './copyIntentRule';

import { clearServedStages, serveStageColors } from '@/testing/servedStageColors';

type TestInstance = ReturnType<typeof create>['root'];
type TestNode = { props: Record<string, unknown> };
type HostNode = TestNode & { type: unknown };

const NEITHER_BOTH: StageMode = {
  name: 'Be (Neither/Both)',
  description:
    'Clear Light is the Neither/Both Mode. It contains within it the healthy expression of all the other Modes. Employing healthy chords of Frequencies from Clear Light is like playing jazz instead of scales.',
  holds_all_modes: true,
};

const PHASES = [
  'Rising',
  'Peaking',
  'Withdrawal',
  'Diminishing',
  'Bottoming Out',
  'Restoration',
] as const;

/** A chord per phase of three notes (stages 1, 5, 9), named so each is unique. */
const CHORD: StagePhaseChord[] = PHASES.map((phase) => ({
  phase,
  notes: [1, 5, 9].map((stageNumber) => ({
    stage_number: stageNumber,
    name: `${phase} note ${String(stageNumber)}`,
  })),
}));

const slug = (phase: string): string => phase.toLowerCase().replace(/\s+/g, '-');

const textChildren = (node: TestInstance): string[] =>
  node
    .findAll((n: TestNode) => typeof n.props.children === 'string')
    .map((n: TestNode) => n.props.children as string);

describe('StageModeSection', () => {
  it('states the Mode by its served name and description', () => {
    const tree = create(<StageModeSection mode={NEITHER_BOTH} chord={CHORD} />);
    const rendered = textChildren(tree.root.findByProps({ testID: 'stage-mode' }));
    expect(rendered).toContain(NEITHER_BOTH.name);
    expect(rendered).toContain(NEITHER_BOTH.description);
  });

  it('renders one chord per phase, in served order, each naming every note', () => {
    const tree = create(<StageModeSection mode={NEITHER_BOTH} chord={CHORD} />);
    const eyebrows = tree.root
      .findByProps({ testID: 'stage-chord' })
      // Host nodes only: the composite Text and its host both carry the prop.
      .findAll(
        (n: HostNode) => typeof n.type === 'string' && n.props.accessibilityRole === 'header',
      )
      .map((n: HostNode) => n.props.children);
    expect(eyebrows).toEqual([...PHASES]);
    for (const chord of CHORD) {
      for (const note of chord.notes) {
        const chip = tree.root.findByProps({
          testID: `stage-chord-${slug(chord.phase)}-note-${String(note.stage_number)}`,
        });
        expect(textChildren(chip)).toContain(note.name);
      }
    }
  });

  it("colours each note with its own stage's colour", () => {
    const tree = create(<StageModeSection mode={NEITHER_BOTH} chord={CHORD} />);
    for (const stageNumber of [1, 5, 9]) {
      const dot = tree.root.findByProps({
        testID: `stage-chord-rising-note-${String(stageNumber)}-dot`,
      });
      const style = [dot.props.style].flat() as Array<Record<string, unknown>>;
      const colour = STAGE_COLORS[STAGE_ORDER[stageNumber - 1] ?? ''];
      expect(style.some((entry) => entry.backgroundColor === colour)).toBe(true);
    }
  });

  it("follows a note's served stage colour once the stages arrive (#2666)", () => {
    const tree = create(<StageModeSection mode={NEITHER_BOTH} chord={CHORD} />);
    act(() => serveStageColors({ 1: 'Teal' }));
    try {
      const dot = tree.root.findByProps({ testID: 'stage-chord-rising-note-1-dot' });
      const style = [dot.props.style].flat() as Array<Record<string, unknown>>;
      expect(style.some((entry) => entry.backgroundColor === STAGE_COLORS.Teal)).toBe(true);
    } finally {
      act(() => clearServedStages());
    }
  });

  it('states the Mode without a chord when none is served', () => {
    const tree = create(<StageModeSection mode={NEITHER_BOTH} chord={[]} />);
    expect(tree.root.findByProps({ testID: 'stage-mode' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'stage-chord' })).toHaveLength(0);
  });

  it('renders null for a stage that states no Mode', () => {
    const tree = create(<StageModeSection mode={null} chord={[]} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('trips zero rank/shame patterns across its full rendered text', () => {
    const tree = create(<StageModeSection mode={NEITHER_BOTH} chord={CHORD} />);
    expect(ranksOrShames(textChildren(tree.root).join(' '))).toBe(false);
  });
});
