/* eslint-env jest */
/* global describe, it, expect */
// Gate 1 contract for the stage-detail integrated/shadow expressions surface.
import React from 'react';
import { create } from 'react-test-renderer';

import { StageExpressionsSection } from '../StageExpressionsSection';
import type { StageManifestation } from '../StageExpressionsSection';

import { ranksOrShames } from './copyIntentRule';

// react-test-renderer ships no node types, so derive the instance from create.
type TestInstance = ReturnType<typeof create>['root'];
type TestNode = { props: Record<string, unknown> };

// Realistic, canon-sourced fixture (Stage 1 / Survival) — the copy an
// implementer's curriculum-backed component would actually render.
const REALISTIC_MANIFESTATIONS: StageManifestation[] = [
  {
    phase: 'Rising',
    integrated: { name: 'Commitment', description: 'A grounded promise to begin showing up.' },
    shadow: { name: 'Over-commitment', description: 'Taking on too much too fast.' },
  },
  {
    phase: 'Peaking',
    integrated: {
      name: 'Diligence',
      description: 'Steady effort anchored in habit and presence.',
    },
    shadow: { name: 'Thriving', description: 'Overextending in a rush of manic progress.' },
  },
  {
    phase: 'Withdrawal',
    integrated: {
      name: 'Steadiness',
      description: 'Returning to baseline without abandoning routine.',
    },
    shadow: { name: 'Burnout', description: 'Energetic collapse from unsustainable output.' },
  },
  {
    phase: 'Diminishing',
    integrated: {
      name: 'Security',
      description: 'Embracing contraction to restore safety and trust.',
    },
    shadow: { name: 'Grasping', description: 'Clinging to momentum as it fades.' },
  },
  {
    phase: 'Bottoming Out',
    integrated: {
      name: 'Stability',
      description: 'Deep stillness that anchors your nervous system.',
    },
    shadow: { name: 'Overwhelm', description: 'Flooded by unmet needs or collapsing structure.' },
  },
  {
    phase: 'Restoration',
    integrated: { name: 'Next Habit', description: 'Humble return with a manageable new step.' },
    shadow: { name: 'New Plan', description: 'Drastic overhaul to escape discomfort.' },
  },
];

const PHASE_SLUGS = [
  'rising',
  'peaking',
  'withdrawal',
  'diminishing',
  'bottoming-out',
  'restoration',
];

// The static headings the component contract requires — checked for
// balance-not-altitude compliance alongside the curriculum copy below.
const HAND_AUTHORED_LABELS = ['Integrated', 'Shadow'];

const textChildren = (node: TestInstance): string[] =>
  node
    .findAll((n: TestNode) => typeof n.props.children === 'string')
    .map((n: TestNode) => n.props.children as string);

describe('StageExpressionsSection', () => {
  it('renders a container with all 6 phase blocks in canonical order', () => {
    const tree = create(<StageExpressionsSection manifestations={REALISTIC_MANIFESTATIONS} />);
    expect(tree.root.findByProps({ testID: 'stage-expressions' })).toBeTruthy();
    for (const slug of PHASE_SLUGS) {
      expect(tree.root.findByProps({ testID: `stage-expression-${slug}` })).toBeTruthy();
    }
  });

  it('shows each phase integrated name + description under the "Integrated" heading', () => {
    const tree = create(<StageExpressionsSection manifestations={REALISTIC_MANIFESTATIONS} />);
    for (const manifestation of REALISTIC_MANIFESTATIONS) {
      const slug = manifestation.phase.toLowerCase().replace(/\s+/g, '-');
      const integrated = tree.root.findByProps({
        testID: `stage-expression-${slug}-integrated`,
      });
      const rendered = textChildren(integrated);
      expect(rendered).toContain('Integrated');
      expect(rendered).toContain(manifestation.integrated.name);
      expect(rendered).toContain(manifestation.integrated.description);
    }
  });

  it('shows each phase shadow name + description under the "Shadow" heading', () => {
    const tree = create(<StageExpressionsSection manifestations={REALISTIC_MANIFESTATIONS} />);
    for (const manifestation of REALISTIC_MANIFESTATIONS) {
      const slug = manifestation.phase.toLowerCase().replace(/\s+/g, '-');
      const shadow = tree.root.findByProps({ testID: `stage-expression-${slug}-shadow` });
      const rendered = textChildren(shadow);
      expect(rendered).toContain('Shadow');
      expect(rendered).toContain(manifestation.shadow.name);
      expect(rendered).toContain(manifestation.shadow.description);
    }
  });

  it('renders null for an empty manifestations array', () => {
    const tree = create(<StageExpressionsSection manifestations={[]} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('trips zero rank/shame patterns for every hand-authored label', () => {
    for (const label of HAND_AUTHORED_LABELS) {
      expect(ranksOrShames(label)).toBe(false);
    }
  });

  it('trips zero rank/shame patterns across the full rendered text of a realistic fixture stage', () => {
    const tree = create(<StageExpressionsSection manifestations={REALISTIC_MANIFESTATIONS} />);
    const allText = textChildren(tree.root).join(' ');
    expect(ranksOrShames(allText)).toBe(false);
  });
});
