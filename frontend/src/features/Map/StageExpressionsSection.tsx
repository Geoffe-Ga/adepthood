import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { StageExpression, StageManifestation } from '../../api';
import { editorialType, onShowcase, radius, showcase, spacing } from '../../design/tokens';

export type { StageExpression, StageManifestation } from '../../api';

// The two faces of a stage in each Wavelength phase read as facets of one wave,
// never a ranking of the person: an integrated (medicinal) expression beside a
// shadow (toxic) one. The headings are the only hand-authored copy; every name
// and description is canon, rendered as received.
const INTEGRATED_LABEL = 'Integrated';
const SHADOW_LABEL = 'Shadow';

/** Slug a phase for a testID: lowercased, spaces collapsed to hyphens. */
const phaseSlug = (phase: string): string => phase.toLowerCase().replace(/\s+/g, '-');

interface ExpressionRowProps {
  expression: StageExpression;
  heading: string;
  testID: string;
}

/** One face of a phase: its heading, canon name, and canon description. */
const ExpressionRow = ({ expression, heading, testID }: ExpressionRowProps): React.JSX.Element => (
  <View style={styles.expression} testID={testID}>
    <Text style={styles.expressionHeading}>{heading}</Text>
    <Text style={styles.expressionName}>{expression.name}</Text>
    <Text style={styles.expressionDescription}>{expression.description}</Text>
  </View>
);

/** One Wavelength phase: a caption eyebrow over its integrated + shadow pair. */
const PhaseBlock = ({
  manifestation,
}: {
  manifestation: StageManifestation;
}): React.JSX.Element => {
  const baseTestId = `stage-expression-${phaseSlug(manifestation.phase)}`;
  return (
    <View style={styles.phaseBlock} testID={baseTestId}>
      <Text style={styles.phaseEyebrow} accessibilityRole="header">
        {manifestation.phase}
      </Text>
      <View style={styles.pair}>
        <ExpressionRow
          expression={manifestation.integrated}
          heading={INTEGRATED_LABEL}
          testID={`${baseTestId}-integrated`}
        />
        <ExpressionRow
          expression={manifestation.shadow}
          heading={SHADOW_LABEL}
          testID={`${baseTestId}-shadow`}
        />
      </View>
    </View>
  );
};

/**
 * The stage-detail expressions surface: each of the six canonical Wavelength
 * phases rendered as an integrated/shadow pair. Renders nothing when the stage
 * carries no manifestations, so a payload predating the field shows no empty
 * scaffold.
 */
export const StageExpressionsSection = ({
  manifestations,
}: {
  manifestations: StageManifestation[];
}): React.JSX.Element | null => {
  if (manifestations.length === 0) {
    return null;
  }
  return (
    <View style={styles.section} testID="stage-expressions">
      {manifestations.map((manifestation) => (
        <PhaseBlock key={manifestation.phase} manifestation={manifestation} />
      ))}
    </View>
  );
};

const EYEBROW_LETTER_SPACING = 0.6;

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing(1.5),
    gap: spacing(1.25),
  },
  phaseBlock: {
    gap: spacing(0.5),
  },
  // Small, non-interactive caption eyebrow naming the Wavelength phase.
  phaseEyebrow: {
    fontFamily: editorialType.serif,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: EYEBROW_LETTER_SPACING,
    textTransform: 'uppercase',
    color: onShowcase.soft,
  },
  pair: {
    flexDirection: 'row',
    gap: spacing(1),
  },
  expression: {
    flex: 1,
    backgroundColor: showcase.raised,
    borderRadius: radius.md,
    padding: spacing(1),
    gap: spacing(0.25),
  },
  expressionHeading: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: EYEBROW_LETTER_SPACING,
    color: onShowcase.soft,
  },
  expressionName: {
    fontFamily: editorialType.serif,
    fontSize: 14,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  expressionDescription: {
    fontSize: 12,
    lineHeight: 18,
    color: onShowcase.soft,
  },
});
