import React from 'react';

import { FEEDBACK_ANSWER_MAX_LENGTH, FEEDBACK_SUMMARY_MAX_LENGTH } from '../feedbackBounds';
import type { FeedbackAnswerField, FeedbackQuestion } from '../feedbackCategories';
import { FeedbackField } from '../FeedbackField';
import type { FeedbackAnswers, FeedbackValidation } from '../feedbackPayload';

interface QuestionFieldsProps {
  questions: readonly FeedbackQuestion[];
  answers: FeedbackAnswers;
  onChange: (field: FeedbackAnswerField, value: string) => void;
  errors: FeedbackValidation['errors'];
  editable: boolean;
}

/** The chosen category's questions, in its own order, each with its own bound. */
export function QuestionFields({
  questions,
  answers,
  onChange,
  errors,
  editable,
}: QuestionFieldsProps): React.JSX.Element {
  return (
    <>
      {questions.map((question) => (
        <FeedbackField
          key={question.field}
          field={question.field}
          label={question.label}
          hint={question.hint}
          value={answers[question.field]}
          onChangeText={(value) => onChange(question.field, value)}
          maxLength={
            question.field === 'summary' ? FEEDBACK_SUMMARY_MAX_LENGTH : FEEDBACK_ANSWER_MAX_LENGTH
          }
          multiline={question.multiline}
          editable={editable}
          error={errors[question.field]}
        />
      ))}
    </>
  );
}
