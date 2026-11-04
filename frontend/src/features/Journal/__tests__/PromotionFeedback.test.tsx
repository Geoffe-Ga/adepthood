/* eslint-env jest */
// The promote-lifecycle notice every promoting surface shares (#3660): the
// journal page's lines, the same words on a chapter's floating card and at
// the foot of a letter.
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { PROMOTED_NOTICE_COPY } from '../promoteExplainerCopy';
import PromotionFeedback, { PROMOTING_COPY, hasPromotionFeedback } from '../PromotionFeedback';

const IDLE = { promoting: false, hint: null, promoted: false, retryPromote: null };

describe('PromotionFeedback', () => {
  it('says nothing while nothing is happening', () => {
    expect(render(<PromotionFeedback {...IDLE} />).toJSON()).toBeNull();
    expect(hasPromotionFeedback(IDLE)).toBe(false);
  });

  it('says "Promoting…" in flight, unless a busy pill already says so', () => {
    const shown = render(<PromotionFeedback {...IDLE} promoting />);
    expect(shown.getByTestId('quote-promotion-inflight')).toHaveTextContent(PROMOTING_COPY);

    const quiet = render(<PromotionFeedback {...IDLE} promoting showInflight={false} />);
    expect(quiet.toJSON()).toBeNull();
    expect(hasPromotionFeedback({ ...IDLE, promoting: true, showInflight: false })).toBe(false);
  });

  it('names where the quote went once it lands', () => {
    const { getByTestId } = render(<PromotionFeedback {...IDLE} promoted />);
    expect(getByTestId('quote-promotion-success')).toHaveTextContent(PROMOTED_NOTICE_COPY);
    expect(hasPromotionFeedback({ ...IDLE, promoted: true })).toBe(true);
  });

  it('puts a failure ahead of a lingering success, with a retry that re-posts', () => {
    const retryPromote = jest.fn(() => Promise.resolve());
    const { getByTestId, queryByTestId } = render(
      <PromotionFeedback
        {...IDLE}
        promoted
        hint="That did not land."
        retryPromote={retryPromote}
      />,
    );
    expect(getByTestId('quote-promotion-error')).toHaveTextContent('That did not land.');
    expect(queryByTestId('quote-promotion-success')).toBeNull();
    fireEvent.press(getByTestId('quote-promotion-retry'));
    expect(retryPromote).toHaveBeenCalledTimes(1);
  });

  it('drops the lines’ own top spacing on a card that pads them itself', () => {
    const spaced = render(<PromotionFeedback {...IDLE} promoted />);
    const flush = render(<PromotionFeedback {...IDLE} promoted flush />);
    const top = (node: ReturnType<typeof spaced.getByTestId>) =>
      StyleSheet.flatten(node.props.style).paddingTop;

    expect(top(spaced.getByTestId('quote-promotion-success'))).toBeGreaterThan(0);
    expect(top(flush.getByTestId('quote-promotion-success'))).toBe(0);
  });
});
