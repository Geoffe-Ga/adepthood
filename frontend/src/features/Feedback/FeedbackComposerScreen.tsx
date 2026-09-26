import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AttachedContextPreview } from './components/AttachedContextPreview';
import { CategoryStep } from './components/CategoryStep';
import { ImpactPicker } from './components/ImpactPicker';
import { QuestionFields } from './components/QuestionFields';
import { SubmitStatus } from './components/SubmitStatus';
import { announceOnIos } from './feedbackAnnounce';
import { FEEDBACK_COMPOSER_COPY } from './feedbackCopy';
import { focusHost, restoreFeedbackOrigin } from './feedbackFocus';
import { FEEDBACK_SUCCESS_COPY } from './feedbackOutcome';
import { FEEDBACK_TEST_IDS } from './feedbackTestIds';
import { useComposerModel, type ComposerModel } from './useComposerModel';

import type { FeedbackReceipt } from '@/api';
import { Button } from '@/components/Button';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent, focusHostStyle, ink, rhythm, SPACING, type as typeRamp } from '@/design/tokens';

/**
 * The beta feedback composer (#2898): choose what kind of report this is, answer
 * that kind's questions, see exactly what will be attached, and send it under a
 * key that makes a second press -- or a restart -- harmless.
 *
 * On open, focus moves to the heading; on close, it returns to the control that
 * opened the composer.
 */
export default function FeedbackComposerScreen(): React.JSX.Element {
  const model = useComposerModel();
  const insets = useSafeAreaInsets();
  const headingRef = useRef<View>(null);

  useEffect(() => {
    focusHost(headingRef.current);
    return restoreFeedbackOrigin;
  }, []);

  const { submitState } = model;
  return (
    <ScreenScaffold
      scroll
      testID={FEEDBACK_TEST_IDS.screen}
      style={{ paddingBottom: insets.bottom }}
    >
      <ComposerHeading headingRef={headingRef} />
      {submitState.status === 'sent' ? (
        <SentView receipt={submitState.receipt} />
      ) : (
        <ComposerForm model={model} />
      )}
    </ScreenScaffold>
  );
}

/**
 * The composer's lead, wrapped in the focus host that takes focus on open.
 * Navigation owns the visible title (the stack header reads "Send feedback"),
 * so the body does not repeat it: the host is *announced* as the title through
 * its accessibilityLabel and carries the lead as its hint, because an
 * accessible View with a label reads only that label on native. On web the
 * host paints no focus ring -- it is not a control (#2951).
 */
function ComposerHeading({
  headingRef,
}: {
  headingRef: React.RefObject<View | null>;
}): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View
      ref={headingRef}
      tabIndex={-1}
      accessible
      accessibilityRole="header"
      accessibilityLabel={FEEDBACK_COMPOSER_COPY.title}
      accessibilityHint={FEEDBACK_COMPOSER_COPY.lead}
      style={focusHostStyle}
      testID={FEEDBACK_TEST_IDS.heading}
    >
      <Text allowFontScaling style={[t.body, styles.lead]}>
        {FEEDBACK_COMPOSER_COPY.lead}
      </Text>
    </View>
  );
}

function ComposerForm({ model }: { model: ComposerModel }): React.JSX.Element {
  const { draftApi, config, frozen, submitState } = model;
  const { draft, hydrated } = draftApi;
  if (!hydrated) {
    return (
      <Text allowFontScaling accessibilityLiveRegion="polite" style={styles.soft}>
        {FEEDBACK_COMPOSER_COPY.loading}
      </Text>
    );
  }
  const locked = frozen || submitState.status === 'sending';
  return (
    <View style={styles.form}>
      <CategoryStep
        selected={draft.category}
        disabled={locked}
        onSelect={(category) => {
          if (!locked) draftApi.setCategory(category);
        }}
      />
      {config === null ? null : (
        <>
          <QuestionFields
            questions={config.questions}
            answers={draft.answers}
            onChange={draftApi.setAnswer}
            errors={model.errors}
            editable={!locked}
          />
          <ImpactPicker
            choices={config.impactChoices}
            selected={draft.impact}
            disabled={locked}
            onSelect={(impact) => {
              if (!locked) draftApi.setImpact(impact);
            }}
            error={model.errors.impact}
          />
          <AttachedContextPreview context={model.previewContext} />
          <SubmitStatus
            failure={submitState.status === 'failed' ? submitState.kind : null}
            frozen={frozen}
            message={model.showValidationMessage ? FEEDBACK_COMPOSER_COPY.needsAttention : null}
          />
          <SendControls model={model} />
        </>
      )}
    </View>
  );
}

function SendControls({ model }: { model: ComposerModel }): React.JSX.Element {
  const sending = model.submitState.status === 'sending';
  return (
    <View style={styles.actions}>
      <Button
        label={model.frozen ? FEEDBACK_COMPOSER_COPY.sendAgain : FEEDBACK_COMPOSER_COPY.send}
        onPress={model.onSend}
        busy={sending}
        testID={FEEDBACK_TEST_IDS.send}
      />
      {model.frozen && !sending ? (
        <Button
          label={FEEDBACK_COMPOSER_COPY.editReport}
          onPress={model.onEdit}
          variant="secondary"
          testID={FEEDBACK_TEST_IDS.edit}
        />
      ) : null}
    </View>
  );
}

/**
 * The confirmation. It replaces the form -- and the Send button that had focus
 * -- so it takes focus itself, and on iOS also speaks the reference, which the
 * live region alone would not.
 */
function SentView({ receipt }: { receipt: FeedbackReceipt }): React.JSX.Element {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const statusRef = useRef<View>(null);
  useEffect(() => {
    focusHost(statusRef.current);
    announceOnIos(
      `${FEEDBACK_SUCCESS_COPY.heading} ${FEEDBACK_SUCCESS_COPY.reference} ${receipt.public_id}.`,
    );
  }, [receipt.public_id]);
  return (
    <View style={styles.form}>
      <View
        ref={statusRef}
        tabIndex={-1}
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={focusHostStyle}
        testID={FEEDBACK_TEST_IDS.status}
      >
        <Text allowFontScaling style={[t.heading, styles.title]}>
          {FEEDBACK_SUCCESS_COPY.heading}
        </Text>
        <Text allowFontScaling style={[t.body, styles.lead]}>
          {`${FEEDBACK_SUCCESS_COPY.reference} `}
          <Text style={styles.reference} testID={FEEDBACK_TEST_IDS.reference} selectable>
            {receipt.public_id}
          </Text>
        </Text>
        <Text allowFontScaling style={[t.caption, styles.soft]}>
          {FEEDBACK_SUCCESS_COPY.keep}
        </Text>
      </View>
      <Button
        label={FEEDBACK_COMPOSER_COPY.done}
        onPress={() => navigation.goBack()}
        variant="secondary"
        testID={FEEDBACK_TEST_IDS.done}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: ink.primary },
  lead: { color: ink.soft, marginTop: SPACING.xs },
  soft: { color: ink.soft, marginTop: rhythm.blockGap },
  form: { marginTop: rhythm.sectionGap, gap: rhythm.blockGap },
  actions: { gap: SPACING.sm },
  reference: { color: accent.strong, fontWeight: '600' },
});
