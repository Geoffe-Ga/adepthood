/**
 * Everything the composer screen renders, derived in one place.
 *
 * The single-payload seam lives here: `payload` is the one `FeedbackCreate`,
 * `previewContext` is that payload's own `context` (or, while an attempt is
 * frozen, the frozen payload's), and `onSend` hands the same object to the
 * submit hook. The preview therefore cannot describe a request other than the
 * one that is sent.
 */
import { useNavigationState, useRoute, type RouteProp } from '@react-navigation/native';
import { useCallback, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { resolveAppBuild } from './appBuild';
import { FEEDBACK_CATEGORY_CONFIG, type FeedbackCategoryConfig } from './feedbackCategories';
import {
  buildFeedbackContext,
  resolveDeviceLocale,
  resolveOriginRouteName,
} from './feedbackContext';
import { parseControlToken } from './feedbackControlTokens';
import {
  buildFeedbackCreate,
  validateFeedbackDraft,
  type FeedbackValidation,
} from './feedbackPayload';
import { useFeedbackDraft, type FeedbackDraftApi } from './useFeedbackDraft';
import { useFeedbackSubmit, type FeedbackSubmitState } from './useFeedbackSubmit';

import type { FeedbackContext } from '@/api';

/** The composer's route params: at most one stable control token. */
export type FeedbackRouteParams = { control?: string } | undefined;

type FeedbackRoute = RouteProp<{ Feedback: FeedbackRouteParams }, 'Feedback'>;

export interface ComposerModel {
  draftApi: FeedbackDraftApi;
  config: FeedbackCategoryConfig | null;
  submitState: FeedbackSubmitState;
  frozen: boolean;
  previewContext: FeedbackContext;
  /** Field errors, shown only once a send has been attempted. */
  errors: FeedbackValidation['errors'];
  showValidationMessage: boolean;
  onSend: () => void;
  onEdit: () => void;
}

function useFeedbackEnvelope(): FeedbackContext {
  const route = useRoute<FeedbackRoute>();
  // Only the token survives parsing; any other param is never read at all.
  const control = parseControlToken(route.params?.control);
  const routeName = useNavigationState((state) => resolveOriginRouteName(state));
  const { width } = useWindowDimensions();
  const locale = useMemo(resolveDeviceLocale, []);
  const appBuild = useMemo(() => resolveAppBuild(), []);
  return useMemo(
    () => buildFeedbackContext({ routeName, control, width, os: Platform.OS, locale, appBuild }),
    [routeName, control, width, locale, appBuild],
  );
}

export function useComposerModel(): ComposerModel {
  const context = useFeedbackEnvelope();
  const draftApi = useFeedbackDraft();
  const submit = useFeedbackSubmit(draftApi);
  const [attempted, setAttempted] = useState(false);
  const { draft, reopenForEdit } = draftApi;
  const { send, reset } = submit;

  const payload = useMemo(() => buildFeedbackCreate(draft, context), [draft, context]);
  const validation = useMemo(() => validateFeedbackDraft(draft), [draft]);
  const frozen = draft.attempt !== null;

  const onSend = useCallback(() => {
    if (draft.attempt === null) {
      setAttempted(true);
      if (!validation.ok) return;
    }
    void send(payload);
  }, [draft.attempt, payload, send, validation.ok]);

  const onEdit = useCallback(() => {
    reset();
    void reopenForEdit();
  }, [reopenForEdit, reset]);

  return {
    draftApi,
    config: draft.category === null ? null : FEEDBACK_CATEGORY_CONFIG[draft.category],
    submitState: submit.state,
    frozen,
    // `payload.context` IS `context` (carried by reference); a frozen attempt wins.
    previewContext: draft.attempt?.payload.context ?? context,
    errors: attempted ? validation.errors : {},
    showValidationMessage: attempted && !validation.ok && !frozen,
    onSend,
    onEdit,
  };
}
