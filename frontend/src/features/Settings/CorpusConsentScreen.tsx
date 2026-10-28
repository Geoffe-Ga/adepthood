import React from 'react';
import { StyleSheet, Text } from 'react-native';

import {
  CORPUS_CONSENT_CONSEQUENCE_HEADING,
  CORPUS_CONSENT_CONSEQUENCE_REMOVAL,
  CORPUS_CONSENT_CONSEQUENCE_SENDING,
  CORPUS_CONSENT_EYEBROW,
  CORPUS_CONSENT_GAIN,
  CORPUS_CONSENT_INTIMATE_LINE,
  CORPUS_CONSENT_LEAD,
  CORPUS_CONSENT_RECORD_LINE,
  CORPUS_CONSENT_SOURCES_HEADING,
  CORPUS_CONSENT_TITLE,
} from './corpusConsentCopy';
import { CorpusConsentRows } from './CorpusConsentRows';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm } from '@/design/tokens';

/**
 * "Writing reflections can draw on" — the full account of what sorting does,
 * over the same switches the Settings hub shows under Your writing.
 *
 * The screen exists because the decision was reachable only over HTTP: the
 * endpoints shipped with the writer, defaulting to off, so every real account's
 * corpus stayed empty and every reflection fell back to a recency window. This
 * is the surface that explains the question in full; the switches themselves,
 * and the question asked before a withdrawal deletes anything, live in
 * ``CorpusConsentRows`` and are mounted here and on the hub alike.
 */

/** The two consequences and the two guarantees, above every switch. */
const Consequences = (): React.JSX.Element => (
  <EditorialSection title={CORPUS_CONSENT_CONSEQUENCE_HEADING} testID="corpus-consent-consequences">
    <Text style={styles.paragraph} testID="corpus-consent-gain">
      {CORPUS_CONSENT_GAIN}
    </Text>
    <Text style={styles.paragraph}>{CORPUS_CONSENT_CONSEQUENCE_SENDING}</Text>
    <Text style={styles.paragraph}>{CORPUS_CONSENT_CONSEQUENCE_REMOVAL}</Text>
    <Text style={styles.paragraphSoft}>{CORPUS_CONSENT_INTIMATE_LINE}</Text>
    <Text style={styles.paragraphSoft}>{CORPUS_CONSENT_RECORD_LINE}</Text>
  </EditorialSection>
);

export default function CorpusConsentScreen(): React.JSX.Element {
  return (
    <ScreenScaffold scroll testID="corpus-consent-screen">
      <ScreenHeader
        eyebrow={CORPUS_CONSENT_EYEBROW}
        title={CORPUS_CONSENT_TITLE}
        lead={CORPUS_CONSENT_LEAD}
      />
      <Consequences />
      <EditorialSection title={CORPUS_CONSENT_SOURCES_HEADING} testID="corpus-consent-sources">
        <CorpusConsentRows />
      </EditorialSection>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  paragraph: {
    fontSize: 15,
    lineHeight: 22,
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  paragraphSoft: {
    fontSize: 14,
    lineHeight: 20,
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
});
